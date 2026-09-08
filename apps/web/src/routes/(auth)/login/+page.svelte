<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import Button from '$lib/components/ui/Button.svelte';
  import Field from '$lib/components/ui/Field.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import PasswordInput from '$lib/components/ui/PasswordInput.svelte';
  import TextInput from '$lib/components/ui/TextInput.svelte';
  /** Подсказка в поле почты. Та же, что в v1. */
  const EMAIL_HINT = 'email@example.com';
  import { errorText } from '$lib/api/failure';
  import { login } from '$lib/features/auth/services/auth';
  import SsoLogin from '$lib/features/sso/components/SsoLogin.svelte';
  import { locale } from '$lib/stores/i18n.svelte';
  import type { PageData } from './$types';

  type Props = { data: PageData };
  const { data }: Props = $props();

  let email = $state('');
  let password = $state('');
  let busy = $state(false);
  let failure = $state<string | null>(null);

  const t = $derived(locale.t);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    failure = null;
    try {
      const answer = await login(email, password);

      // Сверка пароля не всегда заканчивается входом: у человека со вторым
      // фактором сессии ещё нет, и вести его на закрытый экран значит вернуть
      // его же на эту форму.
      if (answer.userHasMfa || answer.requiresMfaSetup) {
        const target = page.url.searchParams.get('redirect');
        const query = target ? `?redirect=${encodeURIComponent(target)}` : '';
        await goto(answer.userHasMfa ? `/login/mfa${query}` : `/login/mfa-setup${query}`);
        return;
      }

      // Вход держится в куке, и данные слоёв надо перечитать: без этого
      // страница остаётся отрисованной для невошедшего.
      await invalidateAll();
      // Человек шёл на закрытый экран, и охрана запомнила куда: возвращаем его
      // туда, а не на общий экран.
      await goto(page.url.searchParams.get('redirect') ?? '/home');
    } catch (error) {
      failure = errorText(error, t);
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>{t('Login')} · Tessera</title></svelte:head>

<form
  data-route="login"
  class="card-soft rounded border border-border bg-surface-raised p-8 shadow-[0_2px_45px_4px_rgba(0,0,0,0.07)]"
  onsubmit={submit}
>
  <h1 class="mb-6 text-center text-2xl font-medium">{t('Login')}</h1>

  <SsoLogin
    workspace={data.workspace}
    redirect={page.url.searchParams.get('redirect')}
    failed={page.url.searchParams.get('error') === 'sso'}
  />

  <Field label={t('Email')}>
    <TextInput
      bind:value={email}
      type="email"
      autocomplete="username"
      placeholder={EMAIL_HINT}
      required
    />
  </Field>
  <Field label={t('Password')}>
    <PasswordInput
      bind:value={password}
      autocomplete="current-password"
      placeholder={t('Your password')}
      required
    />
  </Field>

  <!-- Ссылка над кнопкой и справа, как в v1: под кнопкой она читается как
       второе действие формы, а не как выход из неё. -->
  <p class="mb-4 text-right">
    <a class="text-sm underline" href="/forgot-password">{t('Forgot your password?')}</a>
  </p>

  {#if failure}<Notice message={failure} />{/if}

  <Button type="submit" wide disabled={busy}>{busy ? t('Loading...') : t('Sign In')}</Button>
</form>
