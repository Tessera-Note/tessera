import { execSync } from 'child_process';
import { join, relative } from 'path';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { THROTTLER_SKIP } from '@nestjs/throttler/dist/throttler.constants';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { THROTTLERS } from './throttle.module';

/**
 * Ни один контроллер не должен быть связан более чем одним узким счетчиком.
 *
 * Любой `ThrottlerGuard` проверяет **все** объявленные именованные счетчики,
 * кроме явно пропущенных. Порог входа через каталог, пять запросов за пять
 * минут, стоял в общей настройке и молча ограничивал двенадцать
 * контроллеров: чат, ИИ, MCP, экспорт, SSO, MFA и вход. Нашли это случайно,
 * по жалобе на неоткрывающийся чат.
 *
 * Проверка ловит два случая. Новый контроллер, забывший пропустить чужие
 * счетчики, окажется связан тремя сразу. Новый узкий счетчик в общей
 * настройке свяжет вообще всех.
 *
 * Прежняя редакция разбирала исходники двумя регулярными выражениями: пороги
 * выковыривались из текста модуля, а пропуски из текста контроллера. Так
 * проверяется написание, а не поведение: пропуск, записанный иначе, чем
 * ожидает выражение, читался бы как отсутствующий, а записанный правильно, но
 * не применившийся, как имеющийся. Теперь пороги берутся настоящей константой,
 * а пропуски читаются из метаданных, которые декоратор действительно поставил.
 *
 * Заодно выяснилось, что прежнее утверждение было и по существу неверным. Оно
 * искало пропуски только перед объявлением класса, а в этом коде они стоят на
 * маршрутах, и для своего маршрута такой пропуск действует: ограничитель
 * читает метаданные обработчика, а класс берет только когда у обработчика их
 * нет. Поэтому считается по маршрутам, как считает сам ограничитель.
 *
 * Порог узости взят с запасом: настоящие счетчики этого продукта на порядок
 * ниже, а свободные значения задаются как «фактически выключено».
 */
const TIGHT_LIMIT = 1000;

const SERVER_SRC = join(__dirname, '..', '..');

const tight = THROTTLERS.filter((t) => t.limit <= TIGHT_LIMIT).map(
  (t) => t.name,
);

/**
 * Файлы контроллеров, на которых висит ограничитель.
 *
 * Обход файлов нужен именно здесь: проверка обязана охватить и тот контроллер,
 * который появится завтра, а перечислять их руками значит забыть про новый.
 * Утверждение при этом строится не на тексте файла, а на классе из него.
 */
function guardedControllerFiles(): string[] {
  const found = execSync(
    `grep -rl "ThrottlerGuard" ${SERVER_SRC} --include=*.controller.ts`,
    { encoding: 'utf-8' },
  );

  return found.split('\n').filter(Boolean);
}

/** Классы контроллеров из файла: декораторы к этому моменту уже отработали. */
function controllerClasses(file: string): Array<new (...args: any[]) => any> {
  const loaded = require(file);

  return Object.values(loaded).filter(
    (value): value is new (...args: any[]) => any =>
      typeof value === 'function' && /Controller$/.test(value.name),
  );
}

/** Обработчики маршрутов класса: у метода-маршрута есть метаданные пути. */
function routeHandlers(controller: new (...args: any[]) => any): string[] {
  return Object.getOwnPropertyNames(controller.prototype).filter((name) => {
    if (name === 'constructor') return false;
    const handler = controller.prototype[name];
    return (
      typeof handler === 'function' &&
      Reflect.getMetadata(PATH_METADATA, handler) !== undefined
    );
  });
}

/**
 * Счетчики, действующие на маршруте.
 *
 * Ограничитель разрешает пропуск по каждому имени отдельно: метаданные
 * обработчика перекрывают метаданные класса, а при их отсутствии берется класс.
 */
function isSkipped(
  controller: new (...args: any[]) => any,
  handlerName: string,
  name: string,
): boolean {
  const onHandler = Reflect.getMetadata(
    `${THROTTLER_SKIP}${name}`,
    controller.prototype[handlerName],
  );
  if (onHandler !== undefined) return onHandler === true;

  return Reflect.getMetadata(`${THROTTLER_SKIP}${name}`, controller) === true;
}

function boundThrottlers(
  controller: new (...args: any[]) => any,
  handlerName: string,
): string[] {
  return tight.filter((name) => !isSkipped(controller, handlerName, name));
}

/** Действует ли на маршруте хоть какой-нибудь ограничитель частоты. */
function hasThrottlerGuard(
  controller: new (...args: any[]) => any,
  handlerName: string,
): boolean {
  const guards = [
    ...(Reflect.getMetadata(
      GUARDS_METADATA,
      controller.prototype[handlerName],
    ) ?? []),
    ...(Reflect.getMetadata(GUARDS_METADATA, controller) ?? []),
  ];

  return guards.some((guard: any) => /Throttler/.test(guard?.name ?? ''));
}

/**
 * Правило проекта: у маршрутов под `/ai`, `/mcp` и `/pdf-export` глобального
 * лимита нет, и ограничитель обязан стоять на каждом из них.
 *
 * Проверяется по метаданным охраны, а не по тексту: маршрут, где `@UseGuards`
 * написан, но с другим охранником, текстовый поиск счел бы закрытым. Именно так
 * и оказалось у публичного `pdf-export/render`, принимающего токен отрисовки,
 * и у `pdf-export/download` с `mcp` без ограничителя вовсе.
 */
const RATE_LIMITED_PREFIXES = ['ai', 'mcp', 'api/mcp', 'pdf-export'];

function controllerPaths(controller: new (...args: any[]) => any): string[] {
  const path = Reflect.getMetadata(PATH_METADATA, controller);
  return Array.isArray(path) ? path : [path ?? ''];
}

describe('область действия именованных счетчиков частоты', () => {
  it('в общей настройке объявлены счетчики с порогами', () => {
    expect(THROTTLERS.length).toBeGreaterThan(0);
  });

  it('под ограничителем есть контроллеры', () => {
    expect(guardedControllerFiles().length).toBeGreaterThan(0);
  });

  it.each(guardedControllerFiles())(
    'ни один маршрут не связан более чем одним узким счетчиком: %s',
    (file) => {
      const classes = controllerClasses(file);

      // Файл под ограничителем без класса контроллера означает, что обход
      // перестал находить то, ради чего заведен, и молчать об этом нельзя.
      expect(classes.length).toBeGreaterThan(0);

      const overloaded: string[] = [];

      for (const controller of classes) {
        for (const handlerName of routeHandlers(controller)) {
          const bound = boundThrottlers(controller, handlerName);

          if (bound.length > 1) {
            overloaded.push(
              `${relative(SERVER_SRC, file)} ${controller.name}.${handlerName}: ${bound.join(', ')}`,
            );
          }
        }
      }

      expect(overloaded).toEqual([]);
    },
  );

  /**
   * Маршрут без аутентификации ограничен только адресом, и порог у него должен
   * остаться хоть один.
   *
   * Ограничитель проверяет все объявленные счетчики, кроме пропущенных, поэтому
   * порог держится не упоминанием имени, а отсутствием пропуска. Приписать имя
   * в список пропусков это одна строка, и публичный маршрут молча лишается
   * ограничения. Так устроен `pdf-export/render`, где счетчик отрисовки
   * работает именно потому, что не пропущен.
   */
  it('публичный маршрут сохраняет хотя бы один счетчик', () => {
    const naked: string[] = [];
    let publicGuarded = 0;

    const files = execSync(
      `grep -rl "@Controller" ${SERVER_SRC} --include=*.controller.ts`,
      { encoding: 'utf-8' },
    )
      .split('\n')
      .filter(Boolean);

    for (const file of files) {
      for (const controller of controllerClasses(file)) {
        for (const handlerName of routeHandlers(controller)) {
          if (!hasThrottlerGuard(controller, handlerName)) continue;

          // Ключ берется константой, а не строкой: переименование иначе
          // сделало бы проверку немой, все маршруты прочитались бы
          // непубличными, и она позеленела бы на пустом множестве.
          const isPublic =
            Reflect.getMetadata(
              IS_PUBLIC_KEY,
              controller.prototype[handlerName],
            ) === true ||
            Reflect.getMetadata(IS_PUBLIC_KEY, controller) === true;
          if (!isPublic) continue;

          publicGuarded += 1;

          // Пропуски разрешаются так же, как в `boundThrottlers` выше и как в
          // самом ограничителе: обработчик перекрывает класс.
          const active = THROTTLERS.filter(
            (throttler) => !isSkipped(controller, handlerName, throttler.name),
          );

          if (active.length === 0) {
            naked.push(
              `${relative(SERVER_SRC, file)} ${controller.name}.${handlerName}`,
            );
          }
        }
      }
    }

    expect(naked).toEqual([]);
    // Проверка не должна зеленеть на пустом множестве: публичные маршруты под
    // ограничителем в этом коде есть, и если их вдруг ноль, значит обход
    // перестал их находить.
    expect(publicGuarded).toBeGreaterThan(0);
  });

  it('маршруты без глобального лимита закрыты ограничителем', () => {
    const unguarded: string[] = [];

    const files = execSync(
      `grep -rl "@Controller" ${SERVER_SRC} --include=*.controller.ts`,
      { encoding: 'utf-8' },
    )
      .split('\n')
      .filter(Boolean);

    for (const file of files) {
      for (const controller of controllerClasses(file)) {
        const covered = controllerPaths(controller).some((path) =>
          RATE_LIMITED_PREFIXES.some(
            (prefix) => path === prefix || path.startsWith(`${prefix}/`),
          ),
        );
        if (!covered) continue;

        for (const handlerName of routeHandlers(controller)) {
          if (!hasThrottlerGuard(controller, handlerName)) {
            unguarded.push(
              `${relative(SERVER_SRC, file)} ${controller.name}.${handlerName}`,
            );
          }
        }
      }
    }

    expect(unguarded).toEqual([]);
  });
});
