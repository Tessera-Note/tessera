<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import Button from '$lib/components/ui/Button.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import { ApiError } from '$lib/api/client';
  import { restorePage } from '$lib/features/page/services/pages';
  import { locale } from '$lib/stores/i18n.svelte';
  import type { PageData } from './$types';

  type Props = { data: PageData };
  const { data }: Props = $props();

  const t = $derived(locale.t);

  let busy = $state<string | null>(null);
  let failure = $state<string | null>(null);

  async function restore(pageId: string) {
    busy = pageId;
    failure = null;
    try {
      // Ветвь возвращается целиком, это делает сервер: вернуть один корень
      // значило бы оставить потомков в корзине без родителя.
      await restorePage(pageId);
      await invalidateAll();
    } catch (error) {
      failure = error instanceof ApiError ? t(error.code, error.params) : t('Something went wrong');
    } finally {
      busy = null;
    }
  }
</script>

<svelte:head><title>{t('Trash')} · Tessera</title></svelte:head>

<section data-route="trash" class="mx-auto max-w-3xl">
  <h1 class="mb-1 text-2xl font-semibold">{t('Trash')}</h1>
  <p class="mb-6 text-sm text-text-muted">{data.space.name ?? data.space.slug}</p>

  {#if failure}<Notice message={failure} />{/if}

  <ul data-component="TrashList" class="space-y-2">
    {#each data.pages as page (page.id)}
      <li
        class="flex items-center justify-between gap-4 rounded border border-border bg-surface-raised p-3"
      >
        <div class="min-w-0">
          <p class="truncate font-medium">
            <span aria-hidden="true">{page.icon ?? '📄'}</span>
            {page.title ?? t('Untitled')}
          </p>
          <p class="text-xs text-text-muted">
            {new Date(page.deletedAt).toLocaleString(locale.current)}
          </p>
        </div>
        <Button variant="quiet" disabled={busy === page.id} onclick={() => restore(page.id)}>
          {busy === page.id ? t('Loading...') : t('Restore')}
        </Button>
      </li>
    {:else}
      <li class="text-text-muted">{t('No pages in trash')}</li>
    {/each}
  </ul>
</section>
