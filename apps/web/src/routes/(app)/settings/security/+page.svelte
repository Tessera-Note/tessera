<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import Button from '$lib/components/ui/Button.svelte';
  import Field from '$lib/components/ui/Field.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import Panel from '$lib/components/ui/Panel.svelte';
  import QrCode from '$lib/components/ui/QrCode.svelte';
  import TextInput from '$lib/components/ui/TextInput.svelte';
  import { ApiError } from '$lib/api/client';
  import {
    mfaDisable,
    mfaEnable,
    mfaNewBackupCodes,
    mfaSetup,
    type MfaSetup
  } from '$lib/features/mfa/services/mfa';
  import { locale } from '$lib/stores/i18n.svelte';
  import type { PageData } from './$types';

  type Props = { data: PageData };
  const { data }: Props = $props();

  const t = $derived(locale.t);

  let busy = $state<string | null>(null);
  let failure = $state<string | null>(null);
  let setup = $state<MfaSetup | null>(null);
  //: Код подтверждения. Своё поле у каждой формы: одно на всех означало бы,
  //: что набранное для перевыпуска кодов уходит в отключение фактора.
  let code = $state('');
  let renewCode = $state('');
  let disableCode = $state('');
  let codes = $state<string[] | null>(null);

  async function act(key: string, action: () => Promise<unknown>) {
    busy = key;
    failure = null;
    try {
      await action();
    } catch (error) {
      failure = error instanceof ApiError ? t(error.code, error.params) : t('Something went wrong');
    } finally {
      busy = null;
    }
  }

  const begin = () =>
    act('setup', async () => {
      codes = null;
      setup = await mfaSetup();
    });

  const confirm = (event: SubmitEvent) => {
    event.preventDefault();
    return act('enable', async () => {
      const answer = await mfaEnable(code.trim());
      // Резервные коды приходят один раз и в базе лежат в свёрнутом виде:
      // показать их можно только здесь.
      codes = answer.backupCodes;
      setup = null;
      code = '';
      await invalidateAll();
    });
  };

  const turnOff = (event: SubmitEvent) => {
    event.preventDefault();
    return act('disable', async () => {
      await mfaDisable(disableCode.trim());
      disableCode = '';
      codes = null;
      await invalidateAll();
    });
  };

  const renew = (event: SubmitEvent) => {
    event.preventDefault();
    return act('codes', async () => {
      const answer = await mfaNewBackupCodes(renewCode.trim());
      codes = answer.backupCodes;
      renewCode = '';
      await invalidateAll();
    });
  };
</script>

<svelte:head><title>{t('2-step verification')} · Tessera</title></svelte:head>

<section data-route="settings-security">
  <h1 class="mb-6 text-2xl font-semibold">{t('2-step verification')}</h1>

  {#if failure}<Notice message={failure} />{/if}

  {#if data.status.enforced && !data.status.enabled}
    <Notice
      tone="info"
      message={t(
        'Once enforced, all members must enable two-factor authentication to access the workspace.'
      )}
    />
  {/if}

  {#if codes}
    <Panel
      title={t('Save your backup codes')}
      hint={t(
        'These codes can be used to access your account if you lose access to your authenticator app. Each code can only be used once.'
      )}
    >
      <ul class="mb-3 grid grid-cols-2 gap-1 font-mono text-sm">
        {#each codes as one (one)}
          <li class="rounded bg-surface px-2 py-1">{one}</li>
        {/each}
      </ul>
      <Button variant="quiet" onclick={() => (codes = null)}
        >{t("I've saved my backup codes")}</Button
      >
    </Panel>
  {/if}

  {#if !data.status.enabled}
    <Panel
      title={t('Set up two-factor authentication')}
      hint={t(
        'This adds an extra layer of security to your account by requiring a verification code from your authenticator app.'
      )}
    >
      {#if setup}
        <div class="mb-3">
          <p class="mb-2 text-sm">{t('1. Scan this QR code with your authenticator app')}</p>
          <QrCode value={setup.uri} label={t('1. Scan this QR code with your authenticator app')} />
        </div>
        <p class="mb-2 text-sm">{t('Enter this code manually in your authenticator app:')}</p>
        <p class="mb-3 break-all rounded bg-surface px-3 py-2 font-mono text-sm">{setup.secret}</p>
        <p class="mb-3 break-all text-xs text-text-muted">{setup.uri}</p>

        <form onsubmit={confirm}>
          <Field label={t('Enter the 6-digit code found in your authenticator app')}>
            <TextInput bind:value={code} placeholder="123456" />
          </Field>
          <Button type="submit" disabled={busy === 'enable'}>
            {busy === 'enable' ? t('Loading...') : t('Continue')}
          </Button>
        </form>
      {:else}
        <Button disabled={busy === 'setup'} onclick={begin}>
          {busy === 'setup' ? t('Loading...') : t('Add to authenticator')}
        </Button>
      {/if}
    </Panel>
  {:else}
    <Panel
      title={t('Two-factor authentication')}
      hint={t('Two-factor authentication is active on your account.')}
    >
      <p class="mb-4 text-sm text-text-muted">
        {t('Backup codes')}: {data.status.backupCodesLeft}
        {#if data.status.backupCodesLow}
          <span class="ml-1 text-danger">
            {t('Few backup codes left. Regenerate them while you can still sign in.')}
          </span>
        {/if}
      </p>

      <form class="mb-6" onsubmit={renew}>
        <Field
          label={t('Generate new backup codes')}
          hint={t(
            'You can regenerate new backup codes at any time. This will invalidate all existing codes.'
          )}
        >
          <TextInput
            bind:value={renewCode}
            placeholder={t('Enter a 6-digit code or 8-character backup code')}
          />
        </Field>
        <Button type="submit" disabled={busy === 'codes'}>
          {busy === 'codes' ? t('Loading...') : t('Generate new backup codes')}
        </Button>
      </form>

      <form onsubmit={turnOff}>
        <Field
          label={t('Disable two-factor authentication')}
          hint={t(
            "Disabling two-factor authentication will make your account less secure. You'll only need your password to sign in."
          )}
        >
          <TextInput
            bind:value={disableCode}
            placeholder={t('Enter a 6-digit code or 8-character backup code')}
          />
        </Field>
        <Button type="submit" disabled={busy === 'disable' || data.status.enforced}>
          {busy === 'disable' ? t('Loading...') : t('Disable')}
        </Button>
        {#if data.status.enforced}
          <p class="mt-2 text-xs text-text-muted">
            {t(
              'Once enforced, all members must enable two-factor authentication to access the workspace.'
            )}
          </p>
        {/if}
      </form>
    </Panel>
  {/if}
</section>
