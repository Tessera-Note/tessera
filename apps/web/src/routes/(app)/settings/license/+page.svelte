<script lang="ts">
  import Panel from '$lib/components/ui/Panel.svelte';
  import { locale } from '$lib/stores/i18n.svelte';
  import type { PageData } from './$types';

  type Props = { data: PageData };
  const { data }: Props = $props();

  const t = $derived(locale.t);

  /**
   * Что входит в поставку.
   *
   * Перечень из v1 без изменений: экземпляр разворачивается у себя и наружу за
   * подтверждением не ходит, поэтому здесь не проверка ключа, а перечисление
   * того, что уже работает.
   */
  const features = [
    'AI Integration (Chat, Search & Assistant)',
    'MCP Support',
    'SSO (SAML, OIDC, LDAP)',
    'SCIM Provisioning',
    'Multi-factor Authentication (2FA)',
    'Page-level Permissions',
    'Page Verification & Approval Workflow',
    'Audit Logs',
    'Enterprise Controls',
    'API Keys',
    'Full-text Search in Attachments (PDF, DOCX)',
    'Bases',
    'Templates'
  ];
</script>

<svelte:head><title>{t('License')} · Tessera</title></svelte:head>

<section data-route="settings-license">
  <h1 class="mb-6 text-2xl font-semibold">{t('License')}</h1>

  <div class="mb-4 grid gap-4 sm:grid-cols-2">
    <div class="card-soft rounded-md border border-border bg-surface-raised p-5">
      <p class="text-xs font-bold uppercase tracking-wide text-text-muted">Workspace ID</p>
      <p class="mt-1 break-all text-sm font-semibold">{data.workspace.id}</p>
    </div>
    <div class="card-soft rounded-md border border-border bg-surface-raised p-5">
      <p class="text-xs font-bold uppercase tracking-wide text-text-muted">
        {t('Members')}
      </p>
      <p class="mt-1 text-lg font-semibold">{data.workspace.memberCount ?? '—'}</p>
    </div>
  </div>

  {#if data.version}
    <div class="mb-4 card-soft rounded-md border border-border bg-surface-raised p-5">
      <p class="text-xs font-bold uppercase tracking-wide text-text-muted">{t('Version')}</p>
      <p class="mt-1 text-lg font-semibold">{data.version.currentVersion}</p>
      {#if data.version.latestVersion && data.version.latestVersion !== data.version.currentVersion}
        <p class="mt-1 text-sm text-text-muted">
          {t('{{latestVersion}} is available', { latestVersion: data.version.latestVersion })}
          <a class="ml-2 hover:underline" href={data.version.releaseUrl}>{t('Release notes')}</a>
        </p>
      {/if}
    </div>
  {/if}

  <p class="mb-4 text-sm text-text-muted">
    {t('This instance is operated in house and does not contact an external license service.')}
  </p>

  <Panel>
    <ul class="space-y-1 text-sm">
      {#each features as feature (feature)}
        <li class="flex gap-2">
          <span aria-hidden="true" class="text-accent">✓</span>
          {feature}
        </li>
      {/each}
    </ul>
  </Panel>
</section>
