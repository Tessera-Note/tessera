<script lang="ts">
  import { goto } from '$app/navigation';
  import { locale } from '$lib/stores/i18n.svelte';
  import { VERIFICATION_STATUSES } from '$lib/features/verification/services/verifications';
  import type { PageData } from './$types';

  type Props = { data: PageData };
  const { data }: Props = $props();

  const t = $derived(locale.t);

  function label(status: string): string {
    return VERIFICATION_STATUSES.find((one) => one.value === status)?.label ?? status;
  }

  function choose(event: Event) {
    const chosen = (event.currentTarget as HTMLSelectElement).value;
    return goto(chosen ? `/settings/verifications?status=${chosen}` : '/settings/verifications');
  }

  function when(value: string | null): string {
    return value ? new Date(value).toLocaleDateString(locale.current) : '';
  }
</script>

<svelte:head><title>{t('Page verification')} · Tessera</title></svelte:head>

<section data-route="settings-verifications">
  <h1 class="mb-6 text-2xl font-semibold">{t('Page verification')}</h1>

  <label class="mb-4 block">
    <span class="mb-1 block text-sm text-text-muted">{t('Status')}</span>
    <select
      class="h-9 w-full rounded border border-border-input bg-surface px-3 text-sm text-text outline-none focus:border-accent"
      value={data.status ?? ''}
      onchange={choose}
    >
      <option value="">{t('No filters applied')}</option>
      {#each VERIFICATION_STATUSES as one (one.value)}
        <option value={one.value}>{t(one.label)}</option>
      {/each}
    </select>
  </label>

  <div class="card-soft rounded-md border border-border bg-surface-raised">
    <table data-component="VerificationTable" class="w-full text-left text-sm">
      <thead class="border-b border-border text-text-muted">
        <tr>
          <th class="p-3 font-medium">{t('Page')}</th>
          <th class="p-3 font-medium">{t('Status')}</th>
          <th class="p-3 font-medium">{t('Expires')}</th>
        </tr>
      </thead>
      <tbody>
        {#each data.rows as row (row.id)}
          <tr class="border-b border-border last:border-0">
            <td class="p-3">
              <a class="font-medium hover:underline" href="/s/{row.spaceSlug}/p/{row.pageSlugId}">
                {#if row.pageIcon}<span class="mr-1">{row.pageIcon}</span>{/if}
                {row.pageTitle ?? t('Untitled')}
              </a>
              <p class="text-xs text-text-muted">{row.spaceName ?? row.spaceSlug}</p>
            </td>
            <td class="p-3 text-text-muted">{t(label(row.status))}</td>
            <td class="p-3 text-text-muted">{when(row.expiresAt)}</td>
          </tr>
        {:else}
          <tr><td class="p-3 text-text-muted" colspan="3">{t('No pages')}</td></tr>
        {/each}
      </tbody>
    </table>
  </div>
</section>
