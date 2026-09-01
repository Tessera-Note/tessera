<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import Button from '$lib/components/ui/Button.svelte';
  import Field from '$lib/components/ui/Field.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import TextInput from '$lib/components/ui/TextInput.svelte';
  import { errorText } from '$lib/api/failure';
  import { completeMfaLogin } from '$lib/features/auth/services/auth';
  import { locale } from '$lib/stores/i18n.svelte';

  let code = $state('');
  let busy = $state(false);
  let failure = $state<string | null>(null);

  const t = $derived(locale.t);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    failure = null;
    try {
      await completeMfaLogin(code.trim());
      // Сессия появляется только здесь: до кода её не было, и данные слоёв
      // прочитаны для невошедшего.
      await invalidateAll();
      await goto(page.url.searchParams.get('redirect') ?? '/home');
    } catch (error) {
      failure = errorText(error, t);
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>{t('Two-factor authentication')} · Tessera</title></svelte:head>

<form
  data-route="login-mfa"
  class="rounded-lg border border-border bg-surface-raised p-8 shadow-sm"
  onsubmit={submit}
>
  <h1 class="mb-2 text-xl font-semibold">{t('Two-factor authentication')}</h1>
  <p class="mb-6 text-sm text-text-muted">
    {t('Enter the 6-digit code found in your authenticator app')}
  </p>

  <Field
    label={t('Two-factor authentication')}
    hint={t('Enter a 6-digit code or 8-character backup code')}
  >
    <!-- Поле принимает и одноразовый код, и резервный: разделять их незачем,
         служба проверяет оба одним вызовом. -->
    <TextInput bind:value={code} placeholder="123456" required />
  </Field>

  {#if failure}<Notice message={failure} />{/if}

  <Button type="submit" disabled={busy}>{busy ? t('Loading...') : t('Verify')}</Button>

  <a class="mt-4 block text-sm underline" href="/login">{t('Back to login')}</a>
</form>
