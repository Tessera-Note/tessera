import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

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
 * Порог узости взят с запасом: настоящие счетчики этого продукта на порядок
 * ниже, а свободные значения задаются как «фактически выключено».
 */
const TIGHT_LIMIT = 1000;

const SERVER_SRC = join(__dirname, '..', '..');

function throttlerLimits(): Map<string, number> {
  const module = readFileSync(join(__dirname, 'throttle.module.ts'), 'utf-8');
  const limits = new Map<string, number>();

  for (const [, name, limit] of module.matchAll(
    /\{\s*name:\s*([A-Z_]+),\s*ttl:\s*[\d_]+,\s*limit:\s*([\d_]+)\s*\}/g,
  )) {
    limits.set(name, Number(limit.replace(/_/g, '')));
  }

  return limits;
}

function guardedControllers(): string[] {
  const found = execSync(
    `grep -rl "ThrottlerGuard" ${SERVER_SRC} --include=*.controller.ts`,
    { encoding: 'utf-8' },
  );

  return found.split('\n').filter(Boolean);
}

describe('область действия именованных счетчиков частоты', () => {
  const limits = throttlerLimits();
  const tight = [...limits.entries()]
    .filter(([, limit]) => limit <= TIGHT_LIMIT)
    .map(([name]) => name);

  it('в общей настройке объявлены счетчики с порогами', () => {
    expect(limits.size).toBeGreaterThan(0);
  });

  it('под ограничителем есть контроллеры', () => {
    expect(guardedControllers().length).toBeGreaterThan(0);
  });

  it.each(guardedControllers())(
    'связан не более чем одним узким счетчиком: %s',
    (file) => {
      const source = readFileSync(file, 'utf-8');

      // Пропуски объявляются на контроллере, а не на маршруте: маршрутные
      // послабления область действия не расширяют.
      const skipBlock = source.match(
        /@SkipThrottle\(\{[^}]*\}\)\s*@?[^\n]*\n@?(?:UseGuards|Controller)/,
      );
      const declared = skipBlock
        ? skipBlock[0]
        : (source.match(/@SkipThrottle\(\{[^}]*\}\)/g) ?? []).join(' ');

      const bound = tight.filter((name) => !declared.includes(name));

      expect(bound.length).toBeLessThanOrEqual(1);
    },
  );
});
