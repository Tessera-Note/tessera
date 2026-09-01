<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import Button from '$lib/components/ui/Button.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import { errorText } from '$lib/api/failure';
  import { revokeShare } from '$lib/features/share/services/share';
  import { locale } from '$lib/stores/i18n.svelte';
  import type { PageData } from './$types';

  type Props = { data: PageData };
  const { data }: Props = $props();

  const t = $derived(locale.t);

  let busy = $state<string | null>(null);
  let failure = $state<string | null>(null);

  async function revoke(pageId: string) {
    busy = pageId;
    failure = null;
    try {
      await revokeShare(pageId);
      await invalidateAll();
    } catch (error) {
      failure = errorText(error, t);
    } finally {
      busy = null;
    }
  }
</script>

<svelte:head><title>{t('Public sharing')} · Tessera</title></svelte:head>

<section data-route="settings-sharing">
  <h1 class="mb-6 text-2xl font-semibold">{t('Public sharing')}</h1>

  {#if failure}<Notice message={failure} />{/if}

  <ul data-component="ShareList" class="space-y-2">
    {#each data.shares as share (share.id)}
      <li class="card-soft rounded-md border border-border bg-surface-raised p-5">
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <a
              class="block truncate font-medium hover:underline"
              href="/s/{share.spaceSlug}/p/{share.pageSlugId}"
            >
              {share.pageTitle ?? t('Untitled')}
            </a>
            <p class="mt-1 truncate text-xs text-text-muted">
              {share.spaceName ?? share.spaceSlug}
            </p>
            <p class="mt-1 break-all rounded bg-surface px-2 py-1 text-xs">/share/{share.key}</p>
            {#if share.includeSubPages}
              <p class="mt-1 text-xs text-text-muted">{t('Include subpages')}</p>
            {/if}
          </div>
          <Button
            variant="quiet"
            disabled={busy === share.pageId}
            onclick={() => revoke(share.pageId)}
          >
            {t('Delete share')}
          </Button>
        </div>
      </li>
    {:else}
      <li class="text-sm text-text-muted">{t('No shared pages')}</li>
    {/each}
  </ul>
</section>
