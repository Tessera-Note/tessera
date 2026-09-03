<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import { IconBrandGoogle, IconLock, IconServer } from '@tabler/icons-svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Field from '$lib/components/ui/Field.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import TextInput from '$lib/components/ui/TextInput.svelte';
  import { errorText } from '$lib/api/failure';
  import type { PublicWorkspace } from '$lib/features/auth/services/auth';
  import { autoLogin, loginUrl } from '$lib/features/sso/login';
  import type { LoginProvider } from '$lib/features/sso/login';
  import { ldapLogin } from '$lib/features/sso/services/login';
  import { locale } from '$lib/stores/i18n.svelte';

  type Props = {
    workspace: PublicWorkspace | null;
    /** Куда возвращать после входа. Приходит из адреса экрана входа. */
    redirect?: string | null;
    /** Вход через провайдера уже отказал: пришли обратно с `?error=sso`. */
    failed?: boolean;
  };
  const { workspace, redirect = null, failed = false }: Props = $props();

  const t = $derived(locale.t);

  const providers = $derived(workspace?.authProviders ?? []);

  /** Открытый вход по каталогу: у него нет перехода, только имя и пароль. */
  let asking = $state<LoginProvider | null>(null);
  let username = $state('');
  let password = $state('');
  let busy = $state(false);
  let failure = $state<string | null>(null);

  /**
   * Отметка о самостоятельном переходе.
   *
   * Живёт в хранилище вкладки, а не в состоянии: переход уводит браузер со
   * страницы, и всё, что осталось в памяти, пропадает вместе с ней.
   */
  const ATTEMPT_KEY = 'tessera.ssoAutoAttempt';
  const ATTEMPT_TTL_MS = 5 * 60_000;

  function attempted(): boolean {
    try {
      const at = Number(sessionStorage.getItem(ATTEMPT_KEY));
      return Number.isFinite(at) && at > 0 && Date.now() - at < ATTEMPT_TTL_MS;
    } catch {
      // Хранилища нет: приватное окно или запрет. Считаем, что не переходили.
      return false;
    }
  }

  function remember(): void {
    try {
      sessionStorage.setItem(ATTEMPT_KEY, String(Date.now()));
    } catch {
      // То же: без хранилища предохранителя нет, но вход работает.
    }
  }

  $effect(() => {
    if (!workspace) return;
    const only = autoLogin(workspace, { attempted: attempted(), failed });
    if (!only) return;
    remember();
    window.location.href = loginUrl(only, redirect);
  });

  function pick(provider: LoginProvider) {
    if (provider.type === 'ldap') {
      asking = provider;
      failure = null;
      return;
    }
    window.location.href = loginUrl(provider, redirect);
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!asking) return;

    busy = true;
    failure = null;
    try {
      await ldapLogin(asking.id, { username, password });
      // Сессия уже в куке, и данные слоёв надо перечитать: без этого страница
      // остаётся отрисованной для невошедшего.
      await invalidateAll();
      await goto(redirect ?? '/home');
    } catch (error) {
      failure = errorText(error, t);
    } finally {
      busy = false;
    }
  }

  function icon(kind: string) {
    if (kind === 'google') return IconBrandGoogle;
    if (kind === 'ldap') return IconServer;
    return IconLock;
  }
</script>

{#if providers.length > 0}
  <div data-component="SsoLogin" class="mb-4">
    {#if failed}
      <Notice message={t('Single sign-on failed. Try again or sign in with a password.')} />
    {/if}

    <div class="flex flex-col gap-2">
      {#each providers as provider (provider.id)}
        {@const Icon = icon(provider.type)}
        <button
          class="flex h-9 w-full items-center justify-center gap-2 rounded border border-border bg-surface px-3 text-sm font-medium text-text hover:bg-surface-hover"
          type="button"
          onclick={() => pick(provider)}
        >
          <Icon size={16} stroke={1.7} />
          {t('Sign in with {{provider}}', { provider: provider.name })}
        </button>
      {/each}
    </div>

    {#if asking}
      <form class="mt-3 rounded-md border border-border bg-surface p-3" onsubmit={submit}>
        {#if failure}<Notice message={failure} />{/if}
        <Field label={t('LDAP username')}>
          <TextInput bind:value={username} autocomplete="username" required />
        </Field>
        <Field label={t('Password')}>
          <TextInput
            bind:value={password}
            type="password"
            autocomplete="current-password"
            required
          />
        </Field>
        <div class="flex gap-2">
          <Button type="submit" disabled={busy}>{busy ? t('Loading...') : t('Sign In')}</Button>
          <Button variant="quiet" onclick={() => (asking = null)}>{t('Cancel')}</Button>
        </div>
      </form>
    {/if}

    <!-- Черта без подписи: слово «или» пришлось бы заводить в двенадцати
         словарях ради одного разделителя, а разделяет и без него. -->
    {#if !workspace?.enforceSso}
      <div class="my-4 h-px bg-border"></div>
    {/if}
  </div>
{/if}
