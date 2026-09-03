/**
 * Правила входа через провайдера.
 *
 * Без единого обращения к серверу: разбор проверяется сам по себе, а слой
 * запросов тянет за собой сборку SvelteKit, которой в проверке разбора нет.
 */

/** Провайдер в объёме, который знает экран входа. */
export type LoginProvider = { id: string; name: string; type: string };

/**
 * Адрес начала входа.
 *
 * У Google в пути нет идентификатора провайдера: обратный адрес регистрируется
 * в консоли Google один на установку и не может его нести. Остальные протоколы
 * различают провайдеров путём.
 */
export function loginUrl(provider: LoginProvider, redirect?: string | null): string {
  const base =
    provider.type === 'google'
      ? '/api/sso/google/login'
      : `/api/sso/${provider.type}/${provider.id}/login`;
  const query = redirect ? `?redirect=${encodeURIComponent(redirect)}` : '';
  return `${base}${query}`;
}

/**
 * Уводить ли на провайдера самостоятельно.
 *
 * Когда вход через провайдера обязателен и провайдер единственный, у человека
 * нет другого пути, и лишнее нажатие только мешает. LDAP исключён: у него
 * никуда не уводят, он спрашивает имя и пароль на месте.
 *
 * `attempted` — был ли такой переход недавно; он же предохранитель. Если
 * провайдер отказал и вернул человека обратно, повторный переход закольцевал
 * бы экран входа и не дал прочитать причину. Того же рода `failed`: возврат с
 * `?error=sso` означает, что провайдер только что отказал.
 *
 * Про вошедшего здесь ничего нет нарочно: экран входа уводит его сервером, не
 * дойдя до разметки (`login/+page.server.ts`), и второе такое же условие
 * означало бы вторую проверку того же, которая разойдётся с первой.
 */
export function autoLogin(
  workspace: { enforceSso: boolean; authProviders: LoginProvider[] },
  options: { attempted: boolean; failed: boolean }
): LoginProvider | null {
  if (!workspace.enforceSso) return null;
  if (workspace.authProviders.length !== 1) return null;
  if (options.attempted || options.failed) return null;

  const only = workspace.authProviders[0];
  return only.type === 'ldap' ? null : only;
}
