import { execSync } from 'child_process';
import { join, relative } from 'path';
import { PATH_METADATA } from '@nestjs/common/constants';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/**
 * Опись маршрутов, доступных без аутентификации.
 *
 * `@Public()` снимает `JwtAuthGuard`, то есть меняет поверхность
 * аутентификации. Правило проекта требует ставить его осознанно, но ничем это
 * не подкреплялось: тридцать шесть маршрутов накопились, и добавление
 * тридцать седьмого ничем бы не отличалось от обычной правки.
 *
 * Текстовый поиск по `@Public()` дает сорок совпадений, а маршрутов
 * тридцать шесть: часть декораторов стоит не на обработчиках. Разница между
 * написанным и действующим здесь видна прямо в числах.
 *
 * Опись сверяется по метаданным, которые декоратор действительно поставил, а
 * не по тексту исходника: `@Public()`, написанный внутри закомментированного
 * блока, текстовый поиск счел бы за настоящий, а поставленный через
 * переменную или наследование не заметил бы вовсе.
 *
 * Проверка не запрещает публичные маршруты. Она делает их добавление видимым:
 * новый маршрут роняет ее, и список правится тем же коммитом, где появился
 * маршрут. Это и есть «осознанно».
 */
const SERVER_SRC = join(__dirname, '..', '..');

function controllerFiles(): string[] {
  return execSync(
    `grep -rl "@Controller" ${SERVER_SRC} --include=*.controller.ts`,
    { encoding: 'utf-8' },
  )
    .split('\n')
    .filter(Boolean);
}

function controllerClasses(file: string): Array<new (...args: any[]) => any> {
  // Файл приходит обходом каталога, статическим импортом его не взять:
  // проверка обязана охватить и тот контроллер, который появится завтра.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const loaded = require(file);

  return Object.values(loaded).filter(
    (value): value is new (...args: any[]) => any =>
      typeof value === 'function' && /Controller$/.test(value.name),
  );
}

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

/** Публичность разрешается как в `JwtAuthGuard`: обработчик, затем класс. */
function isPublic(
  controller: new (...args: any[]) => any,
  handlerName: string,
): boolean {
  const onHandler = Reflect.getMetadata(
    IS_PUBLIC_KEY,
    controller.prototype[handlerName],
  );
  if (onHandler !== undefined) return onHandler === true;

  return Reflect.getMetadata(IS_PUBLIC_KEY, controller) === true;
}

function publicRoutes(): string[] {
  const routes: string[] = [];

  for (const file of controllerFiles()) {
    for (const controller of controllerClasses(file)) {
      for (const handlerName of routeHandlers(controller)) {
        if (isPublic(controller, handlerName)) {
          routes.push(
            `${relative(SERVER_SRC, file)} ${controller.name}.${handlerName}`,
          );
        }
      }
    }
  }

  return routes.sort();
}

describe('поверхность аутентификации', () => {
  it('обход находит контроллеры, иначе опись пуста по ошибке', () => {
    expect(controllerFiles().length).toBeGreaterThan(0);
  });

  it('без аутентификации доступны только записанные маршруты', () => {
    expect(publicRoutes()).toEqual(EXPECTED_PUBLIC_ROUTES);
  });
});

/**
 * Список ведется руками. Появился новый публичный маршрут — впишите его сюда
 * тем же коммитом и объясните в ответе, почему он публичный.
 */
const EXPECTED_PUBLIC_ROUTES: string[] = [
  'core/search/search.controller.ts SearchController.searchShare',
  'core/share/share.controller.ts ShareController.getShare',
  'core/share/share.controller.ts ShareController.getSharePageTree',
  'core/share/share.controller.ts ShareController.getSharedPageInfo',
  'core/share/share.controller.ts ShareController.transclusionLookup',
  'core/workspace/controllers/workspace.controller.ts WorkspaceController.acceptInvite',
  'core/workspace/controllers/workspace.controller.ts WorkspaceController.checkHostname',
  'core/workspace/controllers/workspace.controller.ts WorkspaceController.getInvitationById',
  'core/workspace/controllers/workspace.controller.ts WorkspaceController.getWorkspacePublicInfo',
  'ee/mfa/mfa.controller.ts MfaController.enable',
  'ee/mfa/mfa.controller.ts MfaController.setup',
  'ee/mfa/mfa.controller.ts MfaController.validateAccess',
  'ee/mfa/mfa.controller.ts MfaController.verify',
  'ee/pdf-export/pdf-export.controller.ts PdfExportController.render',
  'ee/scim/scim-group.controller.ts ScimGroupController.create',
  'ee/scim/scim-group.controller.ts ScimGroupController.find',
  'ee/scim/scim-group.controller.ts ScimGroupController.list',
  'ee/scim/scim-group.controller.ts ScimGroupController.patch',
  'ee/scim/scim-group.controller.ts ScimGroupController.remove',
  'ee/scim/scim-group.controller.ts ScimGroupController.replace',
  'ee/scim/scim-user.controller.ts ScimUserController.create',
  'ee/scim/scim-user.controller.ts ScimUserController.find',
  'ee/scim/scim-user.controller.ts ScimUserController.list',
  'ee/scim/scim-user.controller.ts ScimUserController.patch',
  'ee/scim/scim-user.controller.ts ScimUserController.remove',
  'ee/scim/scim-user.controller.ts ScimUserController.replace',
  'ee/scim/scim.controller.ts ScimController.resourceTypes',
  'ee/scim/scim.controller.ts ScimController.schemas',
  'ee/scim/scim.controller.ts ScimController.serviceProviderConfig',
  'ee/sso/google.controller.ts GoogleController.callback',
  'ee/sso/google.controller.ts GoogleController.login',
  'ee/sso/ldap.controller.ts LdapController.login',
  'ee/sso/oidc.controller.ts OidcController.callback',
  'ee/sso/oidc.controller.ts OidcController.login',
  'ee/sso/saml.controller.ts SamlController.callback',
  'ee/sso/saml.controller.ts SamlController.login',
];
