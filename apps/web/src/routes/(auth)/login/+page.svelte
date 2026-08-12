<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import Button from '$lib/components/ui/Button.svelte';
  import Field from '$lib/components/ui/Field.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import TextInput from '$lib/components/ui/TextInput.svelte';
  import { ApiError } from '$lib/api/client';
  import { login } from '$lib/features/auth/services/auth';
  import { locale } from '$lib/stores/i18n.svelte';

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
      failure = error instanceof ApiError ? t(error.code, error.params) : t('Something went wrong');
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>{t('Login')} · Tessera</title></svelte:head>

<form
  data-route="login"
  class="rounded-lg border border-border bg-surface-raised p-8 shadow-sm"
  onsubmit={submit}
>
  <h1 class="mb-6 text-xl font-semibold">{t('Login')}</h1>

  <Field label={t('Email')}>
    <TextInput bind:value={email} type="email" autocomplete="username" required />
  </Field>
  <Field label={t('Password')}>
    <TextInput bind:value={password} type="password" autocomplete="current-password" required />
  </Field>

  {#if failure}<Notice message={failure} />{/if}

  <Button type="submit" disabled={busy}>{busy ? t('Loading...') : t('Sign In')}</Button>

  <a class="mt-4 block text-sm underline" href="/forgot-password">{t('Forgot password')}</a>
</form>
