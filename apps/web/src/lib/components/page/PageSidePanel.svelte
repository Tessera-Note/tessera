<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import Button from '$lib/components/ui/Button.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import TextInput from '$lib/components/ui/TextInput.svelte';
  import { ApiError } from '$lib/api/client';
  import { attachLabels, type Label } from '$lib/features/page/services/labels';
  import { getVersion, type Version } from '$lib/features/page/services/history';
  import { plainText } from '$lib/features/page/document';
  import { createShare, revokeShare, type Share } from '$lib/features/share/services/share';
  import type { Backlink } from '$lib/features/page/services/backlinks';
  import type { PermissionInfo } from '$lib/features/page/services/permissions';
  import { removeRestriction, restrictPage } from '$lib/features/page/services/permissions';
  import { locale } from '$lib/stores/i18n.svelte';

  type Props = {
    pageId: string;
    versions: Version[];
    labels: Label[];
    backlinks: Backlink[];
    permission: PermissionInfo | null;
    share: Share | null;
    spaceSlug: string;
  };
  const { pageId, versions, labels, backlinks, permission, share, spaceSlug }: Props = $props();

  const t = $derived(locale.t);

  let tab = $state<'history' | 'labels' | 'links' | 'access'>('history');
  let busy = $state(false);
  let failure = $state<string | null>(null);
  let newLabel = $state('');
  let preview = $state<{ version: number; text: string } | null>(null);

  async function act(action: () => Promise<unknown>) {
    busy = true;
    failure = null;
    try {
      await action();
    } catch (error) {
      failure = error instanceof ApiError ? t(error.code, error.params) : t('Something went wrong');
    } finally {
      busy = false;
    }
  }

  const showVersion = (version: Version) =>
    act(async () => {
      // Версия читается по требованию: список несёт только заголовки, а тело
      // каждой версии это ещё один документ на строку списка.
      const body = await getVersion(version.id);
      preview = { version: body.version, text: plainText(body.content) };
    });

  const addLabel = (event: SubmitEvent) => {
    event.preventDefault();
    if (!newLabel.trim()) return;
    return act(async () => {
      await attachLabels(pageId, [newLabel.trim()]);
      newLabel = '';
      await invalidateAll();
    });
  };

  const toggleRestriction = () =>
    act(async () => {
      await (permission?.hasDirectRestriction ? removeRestriction(pageId) : restrictPage(pageId));
      await invalidateAll();
    });

  const toggleShare = () =>
    act(async () => {
      await (share ? revokeShare(pageId) : createShare({ pageId }));
      await invalidateAll();
    });
</script>

<aside data-component="PageSidePanel" class="w-72 shrink-0 border-l border-border pl-6">
  <nav class="mb-4 flex flex-wrap gap-1 text-sm">
    {#each [['history', t('Page history')], ['labels', t('Labels')], ['links', t('Backlinks')], ['access', t('Access')]] as [key, title] (key)}
      <button
        class="rounded px-2 py-1 hover:bg-surface"
        class:bg-surface={tab === key}
        class:font-medium={tab === key}
        type="button"
        onclick={() => (tab = key as typeof tab)}
      >
        {title}
      </button>
    {/each}
  </nav>

  {#if failure}<Notice message={failure} />{/if}

  {#if tab === 'history'}
    <ul class="space-y-1 text-sm">
      {#each versions as version (version.id)}
        <li>
          <button
            class="w-full rounded px-2 py-1 text-left hover:bg-surface"
            type="button"
            disabled={busy}
            onclick={() => showVersion(version)}
          >
            <span class="font-medium">#{version.version}</span>
            <span class="block text-xs text-text-muted">
              {new Date(version.createdAt).toLocaleString(locale.current)}
            </span>
          </button>
        </li>
      {:else}
        <li class="px-2 text-text-muted">{t('No page history saved yet.')}</li>
      {/each}
    </ul>

    {#if preview}
      <div class="mt-4 rounded border border-border bg-surface p-3">
        <p class="mb-2 text-xs text-text-muted">#{preview.version}</p>
        <p class="whitespace-pre-wrap text-sm">{preview.text}</p>
      </div>
    {/if}
  {:else if tab === 'labels'}
    <ul class="mb-3 flex flex-wrap gap-1">
      {#each labels as label (label.id)}
        <li class="rounded bg-surface px-2 py-0.5 text-xs">{label.name}</li>
      {:else}
        <li class="text-sm text-text-muted">{t('No labels yet')}</li>
      {/each}
    </ul>
    <form class="flex gap-2" onsubmit={addLabel}>
      <div class="flex-1"><TextInput bind:value={newLabel} placeholder={t('Add label')} /></div>
      <Button type="submit" disabled={busy}>{t('Add')}</Button>
    </form>
  {:else if tab === 'links'}
    <ul class="space-y-1 text-sm">
      {#each backlinks as link (link.id)}
        <li>
          <a
            class="block truncate rounded px-2 py-1 hover:bg-surface"
            href="/s/{spaceSlug}/p/{link.slugId}"
          >
            {link.title ?? t('Untitled')}
          </a>
        </li>
      {:else}
        <li class="px-2 text-text-muted">{t('No pages link here yet.')}</li>
      {/each}
    </ul>
  {:else}
    <div class="space-y-4 text-sm">
      <div>
        <p class="mb-1 font-medium">{t('Page permissions')}</p>
        <p class="mb-2 text-xs text-text-muted">
          {#if permission?.hasDirectRestriction}
            {t('Only people listed below can access this page')}
          {:else if permission?.hasInheritedRestriction}
            {t('Inherits restrictions from ancestor page')}
          {:else}
            {t('Everyone in this space can access')}
          {/if}
        </p>
        {#if permission?.userAccess.canManage}
          <Button variant="quiet" disabled={busy} onclick={toggleRestriction}>
            {permission.hasDirectRestriction ? t('Open') : t('Restricted')}
          </Button>
        {/if}
      </div>

      <div>
        <p class="mb-1 font-medium">{t('Share to web')}</p>
        {#if share}
          <!--
            Ключ ссылки и есть учётные данные того, кто по ней придёт: он
            показывается тому, кто ссылку завёл, и больше нигде не хранится.
          -->
          <p class="mb-1 break-all rounded bg-surface px-2 py-1 text-xs">/share/{share.key}</p>
          <p class="mb-2 text-xs text-text-muted">
            {t('Anyone with the link can view this page')}
          </p>
        {:else}
          <p class="mb-2 text-xs text-text-muted">{t('No shared pages')}</p>
        {/if}
        {#if permission?.userAccess.canManage}
          <Button variant="quiet" disabled={busy} onclick={toggleShare}>
            {share ? t('Delete share') : t('Share')}
          </Button>
        {/if}
      </div>
    </div>
  {/if}
</aside>
