<script lang="ts">
  import Button from '$lib/components/ui/Button.svelte';
  import Field from '$lib/components/ui/Field.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import TextInput from '$lib/components/ui/TextInput.svelte';
  import { errorText } from '$lib/api/failure';
  import { forgotPassword } from '$lib/features/auth/services/auth';
  import { locale } from '$lib/stores/i18n.svelte';

  let email = $state('');
  let busy = $state(false);
  let sent = $state(false);
  let failure = $state<string | null>(null);

  const t = $derived(locale.t);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    failure = null;
    try {
      await forgotPassword(email);
      // Ответ одинаков для заведённого и незаведённого адреса: разные ответы
      // позволяют перебором узнать, кто здесь работает.
      sent = true;
    } catch (error) {
      failure = errorText(error, t);
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>{t('Forgot password')} · Tessera</title></svelte:head>

<form
  data-route="forgot-password"
  class="card-soft rounded border border-border bg-surface-raised p-8 shadow-[0_2px_45px_4px_rgba(0,0,0,0.07)]"
  onsubmit={submit}
>
  <h1 class="mb-6 text-center text-2xl font-medium">{t('Forgot password')}</h1>

  {#if sent}
    <Notice
      tone="info"
      message={t('A password reset link has been sent to your email. Please check your inbox.')}
    />
    <a class="text-sm underline" href="/login">{t('Back to login')}</a>
  {:else}
    <Field label={t('Email')}>
      <TextInput
        bind:value={email}
        type="email"
        autocomplete="username"
        placeholder="email@example.com"
        required
      />
    </Field>

    {#if failure}<Notice message={failure} />{/if}

    <Button type="submit" wide disabled={busy}>
      {busy ? t('Loading...') : t('Send reset link')}
    </Button>
    <a class="mt-4 block text-sm underline" href="/login">{t('Back to login')}</a>
  {/if}
</form>
