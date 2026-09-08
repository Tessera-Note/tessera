<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import Button from '$lib/components/ui/Button.svelte';
  import Field from '$lib/components/ui/Field.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import QrCode from '$lib/components/ui/QrCode.svelte';
  import TextInput from '$lib/components/ui/TextInput.svelte';
  import { errorText } from '$lib/api/failure';
  import { enrollMfaEnable, enrollMfaSetup } from '$lib/features/auth/services/auth';
  import { locale } from '$lib/stores/i18n.svelte';

  let secret = $state<string | null>(null);
  let uri = $state('');
  let code = $state('');
  let codes = $state<string[] | null>(null);
  let busy = $state(false);
  let failure = $state<string | null>(null);

  const t = $derived(locale.t);

  async function act(action: () => Promise<unknown>) {
    busy = true;
    failure = null;
    try {
      await action();
    } catch (error) {
      failure = errorText(error, t);
    } finally {
      busy = false;
    }
  }

  const begin = () =>
    act(async () => {
      const answer = await enrollMfaSetup();
      secret = answer.secret;
      uri = answer.uri;
    });

  const finish = (event: SubmitEvent) => {
    event.preventDefault();
    return act(async () => {
      // Сессия появляется здесь же: код подтверждён, требование выполнено.
      const answer = await enrollMfaEnable(code.trim());
      codes = answer.backupCodes;
      await invalidateAll();
    });
  };

  const go = () => goto(page.url.searchParams.get('redirect') ?? '/home');
</script>

<svelte:head><title>{t('Set up two-factor authentication')} · Tessera</title></svelte:head>

<section
  data-route="login-mfa-setup"
  class="card-soft rounded border border-border bg-surface-raised p-8 shadow-[0_2px_45px_4px_rgba(0,0,0,0.07)]"
>
  <h1 class="mb-2 text-center text-2xl font-medium">{t('Set up two-factor authentication')}</h1>
  <p class="mb-6 text-sm text-text-muted">
    {t(
      'To continue accessing your workspace, you must set up two-factor authentication. This adds an extra layer of security to your account.'
    )}
  </p>

  {#if failure}<Notice message={failure} />{/if}

  {#if codes}
    <p class="mb-2 text-sm">{t('Save your backup codes')}</p>
    <p class="mb-3 text-xs text-text-muted">
      {t(
        'These codes can be used to access your account if you lose access to your authenticator app. Each code can only be used once.'
      )}
    </p>
    <ul class="mb-4 grid grid-cols-2 gap-1 font-mono text-sm">
      {#each codes as one (one)}
        <li class="rounded bg-surface px-2 py-1">{one}</li>
      {/each}
    </ul>
    <Button onclick={go}>{t("I've saved my backup codes")}</Button>
  {:else if secret}
    <div class="mb-3">
      <p class="mb-2 text-sm">{t('1. Scan this QR code with your authenticator app')}</p>
      <QrCode value={uri} label={t('1. Scan this QR code with your authenticator app')} />
    </div>
    <p class="mb-2 text-sm">{t('Enter this code manually in your authenticator app:')}</p>
    <p class="mb-3 break-all rounded bg-surface px-3 py-2 font-mono text-sm">{secret}</p>
    <p class="mb-4 break-all text-xs text-text-muted">{uri}</p>

    <form onsubmit={finish}>
      <Field label={t('Enter the 6-digit code found in your authenticator app')}>
        <TextInput bind:value={code} placeholder="123456" required />
      </Field>
      <Button type="submit" wide disabled={busy}>{busy ? t('Loading...') : t('Continue')}</Button>
    </form>
  {:else}
    <Button disabled={busy} onclick={begin}>
      {busy ? t('Loading...') : t('Add to authenticator')}
    </Button>
  {/if}

  <a class="mt-4 block text-sm underline" href="/login">{t('Back to login')}</a>
</section>
