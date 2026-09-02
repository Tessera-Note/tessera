<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import Button from '$lib/components/ui/Button.svelte';
  import Confirm from '$lib/components/ui/Confirm.svelte';
  import Field from '$lib/components/ui/Field.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import Panel from '$lib/components/ui/Panel.svelte';
  import Select from '$lib/components/ui/Select.svelte';
  import Textarea from '$lib/components/ui/Textarea.svelte';
  import TextInput from '$lib/components/ui/TextInput.svelte';
  import Toggle from '$lib/components/ui/Toggle.svelte';
  import { errorText } from '$lib/api/failure';
  import {
    createProvider,
    deleteProvider,
    updateProvider,
    type AuthProvider,
    type ProviderValues
  } from '$lib/features/sso/services/providers';
  import {
    createScimToken,
    revokeScimToken,
    type CreatedScimToken
  } from '$lib/features/scim/services/tokens';
  import { locale } from '$lib/stores/i18n.svelte';
  import type { PageData } from './$types';

  type Props = { data: PageData };
  const { data }: Props = $props();

  const t = $derived(locale.t);

  let busy = $state<string | null>(null);
  let failure = $state<string | null>(null);
  let mismatch = $state<{ appUrl: string; origin: string } | null>(null);

  /** Какого провайдера правим. `new` означает форму заведения. */
  let editing = $state<string | null>(null);

  /**
   * Черновик формы. Все поля строками, а не `string | null`: поле ввода
   * связывается со строкой, и пустое значение здесь означает «не заполнено» —
   * ровно то же, что и на сервере.
   */
  type Draft = {
    name: string;
    type: AuthProvider['type'];
    isEnabled: boolean;
    allowSignup: boolean;
    groupSync: boolean;
    groupClaimName: string;
    oidcIssuer: string;
    oidcClientId: string;
    oidcClientSecret: string;
    samlUrl: string;
    samlCertificate: string;
    ldapUrl: string;
    ldapBaseDn: string;
    ldapBindDn: string;
    ldapBindPassword: string;
    ldapUserSearchFilter: string;
    ldapTlsEnabled: boolean;
    ldapTlsCaCert: string;
  };

  const blank = (): Draft => ({
    name: '',
    type: 'oidc',
    isEnabled: false,
    allowSignup: false,
    groupSync: false,
    groupClaimName: '',
    oidcIssuer: '',
    oidcClientId: '',
    oidcClientSecret: '',
    samlUrl: '',
    samlCertificate: '',
    ldapUrl: '',
    ldapBaseDn: '',
    ldapBindDn: '',
    ldapBindPassword: '',
    ldapUserSearchFilter: '',
    ldapTlsEnabled: false,
    ldapTlsCaCert: ''
  });

  let form = $state<Draft>(blank());

  let tokenName = $state('');
  let created = $state<CreatedScimToken | null>(null);

  async function act(key: string, action: () => Promise<unknown>) {
    busy = key;
    failure = null;
    try {
      await action();
      await invalidateAll();
    } catch (error) {
      failure = errorText(error, t);
    } finally {
      busy = null;
    }
  }

  function begin(provider?: AuthProvider) {
    mismatch = null;
    editing = provider?.id ?? 'new';
    form = provider
      ? {
          ...blank(),
          name: provider.name,
          type: provider.type,
          isEnabled: provider.isEnabled,
          allowSignup: provider.allowSignup,
          groupSync: provider.groupSync,
          groupClaimName: provider.groupClaimName ?? '',
          oidcIssuer: provider.oidcIssuer ?? '',
          oidcClientId: provider.oidcClientId ?? '',
          samlUrl: provider.samlUrl ?? '',
          samlCertificate: provider.samlCertificate ?? '',
          ldapUrl: provider.ldapUrl ?? '',
          ldapBaseDn: provider.ldapBaseDn ?? '',
          ldapBindDn: provider.ldapBindDn ?? '',
          ldapUserSearchFilter: provider.ldapUserSearchFilter ?? '',
          ldapTlsEnabled: provider.ldapTlsEnabled ?? false,
          ldapTlsCaCert: provider.ldapTlsCaCert ?? ''
        }
      : blank();
  }

  function save(event: SubmitEvent) {
    event.preventDefault();
    if (!form.name.trim()) return;

    return act('save', async () => {
      // Пустой секрет не отправляется вовсе: на сервере пустое значение
      // означает «не менять», и лишнее поле в запросе только запутывает.
      const values: ProviderValues = { ...form };
      if (!form.oidcClientSecret) delete values.oidcClientSecret;
      if (!form.ldapBindPassword) delete values.ldapBindPassword;

      const saved =
        editing === 'new'
          ? await createProvider(values)
          : await updateProvider(editing as string, values);
      mismatch = saved.appUrlMismatch ?? null;
      editing = null;
    });
  }

  function makeToken(event: SubmitEvent) {
    event.preventDefault();
    if (!tokenName.trim()) return;
    return act('token', async () => {
      // Значение видно один раз: в базе от него остаётся только отпечаток.
      created = await createScimToken(tokenName.trim());
      tokenName = '';
    });
  }

  const kinds = [
    { value: 'oidc', label: 'OIDC' },
    { value: 'saml', label: 'SAML' },
    { value: 'ldap', label: 'LDAP' }
  ];

  const when = (value: string | null | undefined) =>
    value
      ? new Intl.DateTimeFormat(locale.current, { dateStyle: 'medium' }).format(new Date(value))
      : t('Never');
</script>

<svelte:head><title>{t('Single sign-on (SSO)')} · Tessera</title></svelte:head>

<section data-route="settings-sso">
  <h1 class="mb-6 text-2xl font-semibold">{t('Single sign-on (SSO)')}</h1>

  {#if failure}<Notice message={failure} />{/if}

  {#if mismatch}
    <Notice
      tone="info"
      message={t(
        'APP_URL on the server ({{appUrl}}) does not match the address this page is open at ({{origin}}). Sign-in through this provider will be rejected until they match. Update APP_URL in the server environment and restart, or open the app at that address.',
        mismatch
      )}
    />
  {/if}

  {#if editing}
    <form onsubmit={save}>
      <Panel title={editing === 'new' ? t('Add SSO provider') : t('Edit provider')}>
        <Field label={t('Provider name')}>
          <TextInput bind:value={form.name} />
        </Field>

        {#if editing === 'new'}
          <Field label={t('Type')}>
            <Select bind:value={form.type} options={kinds} />
          </Field>
        {/if}

        {#if form.type === 'oidc'}
          <Field label={t('Issuer URL')}>
            <TextInput bind:value={form.oidcIssuer} placeholder="https://issuer.example.com" />
          </Field>
          <Field label={t('Client id')}>
            <TextInput bind:value={form.oidcClientId} />
          </Field>
          <Field
            label={t('Client secret')}
            hint={editing === 'new'
              ? undefined
              : t('Stored encrypted. Leave empty to keep the current key.')}
          >
            <TextInput type="password" bind:value={form.oidcClientSecret} />
          </Field>
        {:else if form.type === 'saml'}
          <Field label={t('SSO URL')}>
            <TextInput bind:value={form.samlUrl} />
          </Field>
          <Field label={t('Certificate')}>
            <Textarea bind:value={form.samlCertificate} rows={5} />
          </Field>
        {:else if form.type === 'ldap'}
          <Field label={t('LDAP URL')} hint="ldap://directory.example.com">
            <TextInput bind:value={form.ldapUrl} />
          </Field>
          <Field label={t('Base DN')}>
            <TextInput bind:value={form.ldapBaseDn} placeholder="dc=example,dc=com" />
          </Field>
          <Field label={t('Bind DN')}>
            <TextInput bind:value={form.ldapBindDn} />
          </Field>
          <Field
            label={t('LDAP password')}
            hint={editing === 'new'
              ? undefined
              : t('Stored encrypted. Leave empty to keep the current key.')}
          >
            <TextInput type="password" bind:value={form.ldapBindPassword} />
          </Field>
          <Field label={t('User filter')} hint={'(uid={username})'}>
            <TextInput bind:value={form.ldapUserSearchFilter} />
          </Field>
          <Toggle
            label={t('Use StartTLS')}
            hint={t(
              'Upgrades a plain ldap:// connection to TLS. Not needed for ldaps://, which is already encrypted.'
            )}
            checked={form.ldapTlsEnabled}
            onchange={(value) => (form.ldapTlsEnabled = value)}
          />
        {/if}

        <Toggle
          label={t('Enabled')}
          hint={t('Enable this provider')}
          checked={form.isEnabled}
          onchange={(value) => (form.isEnabled = value)}
        />
        <Toggle
          label={t('Allow signup')}
          hint={t('Only users with email addresses from these domains can signup via SSO.')}
          checked={form.allowSignup}
          onchange={(value) => (form.allowSignup = value)}
        />
        <Toggle
          label={t('Group sync')}
          hint={t('Sync groups')}
          checked={form.groupSync}
          onchange={(value) => (form.groupSync = value)}
        />
        {#if form.groupSync}
          <Field label={t('Group claim')}>
            <TextInput bind:value={form.groupClaimName} placeholder="groups" />
          </Field>
        {/if}

        <div class="flex gap-2">
          <Button type="submit" disabled={busy === 'save'}>
            {busy === 'save' ? t('Loading...') : t('Save')}
          </Button>
          <Button variant="quiet" onclick={() => (editing = null)}>{t('Cancel')}</Button>
        </div>
      </Panel>
    </form>
  {:else}
    <div class="mb-4">
      <Button onclick={() => begin()}>{t('Add SSO provider')}</Button>
    </div>
  {/if}

  <div class="mb-8 card-soft rounded-md border border-border bg-surface-raised">
    <table data-component="ProviderTable" class="w-full text-left text-sm">
      <thead class="border-b border-border text-text-muted">
        <tr>
          <th class="p-3 font-medium">{t('Provider name')}</th>
          <th class="p-3 font-medium">{t('Type')}</th>
          <th class="p-3 font-medium">{t('Status')}</th>
          <th class="p-3"></th>
        </tr>
      </thead>
      <tbody>
        {#each data.providers as provider (provider.id)}
          <tr class="border-b border-border last:border-0">
            <td class="p-3 font-medium">{provider.name}</td>
            <td class="p-3 uppercase text-text-muted">{provider.type}</td>
            <td class="p-3 text-text-muted">
              {provider.isEnabled ? t('Enabled') : t('Disabled')}
            </td>
            <td class="p-3 text-right">
              <span class="inline-flex flex-wrap items-center justify-end gap-2">
                <Button variant="quiet" onclick={() => begin(provider)}>{t('Edit')}</Button>
                <Confirm
                  label={t('Delete')}
                  question={t('Are you sure you want to delete this SSO provider?')}
                  disabled={busy === provider.id}
                  onconfirm={() => act(provider.id, () => deleteProvider(provider.id))}
                />
              </span>
            </td>
          </tr>
        {:else}
          <tr>
            <td class="p-6 text-center text-text-muted" colspan="4">
              {t('No SSO providers found.')}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>

  <h2 class="mb-4 text-xl font-semibold">{t('SCIM tokens')}</h2>
  <p class="mb-4 text-sm text-text-muted">
    {t('Automatically provision users and groups from your identity provider via SCIM.')}
  </p>

  {#if created}
    <Panel
      title={t('Created SCIM token')}
      hint={t("Make sure to copy your {{credential}} now. You won't be able to see it again!", {
        credential: t('SCIM token')
      })}
    >
      <p class="mb-3 break-all rounded bg-surface px-3 py-2 font-mono text-sm">{created.token}</p>
      <div class="flex gap-2">
        <Button
          variant="quiet"
          onclick={() => navigator.clipboard?.writeText(created?.token ?? '')}
        >
          {t('Copy')}
        </Button>
        <Button variant="quiet" onclick={() => (created = null)}>{t('Close')}</Button>
      </div>
    </Panel>
  {/if}

  <form onsubmit={makeToken}>
    <Panel title={t('Create token')}>
      <Field label={t('Name')}>
        <TextInput bind:value={tokenName} placeholder={t('Enter a descriptive token name')} />
      </Field>
      <Button type="submit" disabled={busy === 'token'}>
        {busy === 'token' ? t('Loading...') : t('Create')}
      </Button>
    </Panel>
  </form>

  <div class="card-soft rounded-md border border-border bg-surface-raised">
    <table data-component="ScimTokenTable" class="w-full text-left text-sm">
      <thead class="border-b border-border text-text-muted">
        <tr>
          <th class="p-3 font-medium">{t('Name')}</th>
          <th class="p-3 font-medium">{t('Token')}</th>
          <th class="p-3 font-medium">{t('Last used')}</th>
          <th class="p-3"></th>
        </tr>
      </thead>
      <tbody>
        {#each data.tokens as token (token.id)}
          <tr class="border-b border-border last:border-0">
            <td class="p-3 font-medium">{token.name}</td>
            <td class="p-3 font-mono text-text-muted">…{token.lastFour}</td>
            <td class="p-3 text-text-muted">{when(token.lastUsedAt)}</td>
            <td class="p-3 text-right">
              <Confirm
                label={t('Revoke')}
                question={t(
                  'This action cannot be undone. Your identity provider will stop syncing immediately.'
                )}
                disabled={busy === token.id}
                onconfirm={() => act(token.id, () => revokeScimToken(token.id))}
              />
            </td>
          </tr>
        {:else}
          <tr>
            <td class="p-6 text-center text-text-muted" colspan="4">{t('No tokens found')}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</section>
