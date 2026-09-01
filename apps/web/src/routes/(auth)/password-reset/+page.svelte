<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import Button from '$lib/components/ui/Button.svelte';
  import Field from '$lib/components/ui/Field.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import TextInput from '$lib/components/ui/TextInput.svelte';
  import { errorText } from '$lib/api/failure';
  import { resetPassword } from '$lib/features/auth/services/auth';
  import { locale } from '$lib/stores/i18n.svelte';

  let password = $state('');
  let confirmation = $state('');
  let busy = $state(false);
  let failure = $state<string | null>(null);

  const t = $derived(locale.t);
  const token = $derived(page.url.searchParams.get('token') ?? '');

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (password !== confirmation) {
      // Сверка здесь, а не на сервере: он второго поля не видит, и ошибка
      // набора обошлась бы человеку сменой пароля на тот, которого он не знает.
      failure = t('Passwords do not match');
      return;
    }

    busy = true;
    failure = null;
    try {
      await resetPassword(token, password);
      // Сессию смена пароля не заводит: сервер отвечает признаком и только.
      // Человек входит новым паролем сам — и проходит второй фактор, если он у
      // него включён. Прежний переход на закрытый экран возвращал его сюда же.
      await goto('/login');
    } catch (error) {
      failure = errorText(error, t);
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>{t('Reset password')} · Tessera</title></svelte:head>

<form
  data-route="password-reset"
  class="card-soft rounded-md border border-border bg-surface-raised p-8 shadow-sm"
  onsubmit={submit}
>
  <h1 class="mb-6 text-xl font-semibold">{t('Reset password')}</h1>

  {#if !token}
    <Notice message={t('The link is invalid or has expired')} />
    <a class="text-sm underline" href="/forgot-password">{t('Forgot password')}</a>
  {:else}
    <Field label={t('New password')}>
      <TextInput bind:value={password} type="password" autocomplete="new-password" required />
    </Field>
    <Field label={t('Confirm password')}>
      <TextInput bind:value={confirmation} type="password" autocomplete="new-password" required />
    </Field>

    {#if failure}<Notice message={failure} />{/if}

    <Button type="submit" disabled={busy}>{busy ? t('Loading...') : t('Reset password')}</Button>
  {/if}
</form>
