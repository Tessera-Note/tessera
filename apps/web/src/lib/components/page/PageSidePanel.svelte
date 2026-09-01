<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import Button from '$lib/components/ui/Button.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import TextInput from '$lib/components/ui/TextInput.svelte';
  import { errorText } from '$lib/api/failure';
  import { attachLabels, detachLabel, type Label } from '$lib/features/page/services/labels';
  import { getVersion, type Version } from '$lib/features/page/services/history';
  import { plainText } from '$lib/features/page/document';
  import { createShare, revokeShare, type Share } from '$lib/features/share/services/share';
  import type { Backlink } from '$lib/features/page/services/backlinks';
  import type { PagePermission, PermissionInfo } from '$lib/features/page/services/permissions';
  import {
    addPermission,
    listPermissions,
    removePermission,
    removeRestriction,
    restrictPage
  } from '$lib/features/page/services/permissions';
  import { spaceMembers, type SpaceMember } from '$lib/features/space/services/spaces';
  import { locale } from '$lib/stores/i18n.svelte';

  type Props = {
    pageId: string;
    spaceId: string;
    versions: Version[];
    labels: Label[];
    backlinks: Backlink[];
    permission: PermissionInfo | null;
    share: Share | null;
    spaceSlug: string;
  };
  const { pageId, spaceId, versions, labels, backlinks, permission, share, spaceSlug }: Props =
    $props();

  const t = $derived(locale.t);

  let tab = $state<'history' | 'labels' | 'links' | 'access'>('history');
  let busy = $state(false);
  let failure = $state<string | null>(null);
  let newLabel = $state('');
  let preview = $state<{ version: number; text: string } | null>(null);

  //: Роли доступа к странице. Значения из v1: их же понимает сервер.
  const ROLES = [
    { value: 'writer', label: 'Can edit' },
    { value: 'reader', label: 'Can view' }
  ];

  let granted = $state<PagePermission[] | null>(null);
  let candidates = $state<SpaceMember[]>([]);
  let chosen = $state('');
  let role = $state('reader');

  /**
   * Список допущенных читается при открытии вкладки, а не вместе со страницей.
   *
   * Он нужен только тому, кто открыл вкладку у закрытой страницы, а запрос за
   * ним идёт на каждый показ страницы: у открытой страницы список пуст по
   * определению.
   */
  $effect(() => {
    if (tab !== 'access' || !permission?.hasDirectRestriction || granted !== null) return;
    granted = [];
    void act(async () => {
      const [rows, members] = await Promise.all([listPermissions(pageId), spaceMembers(spaceId)]);
      granted = rows;
      candidates = members;
    });
  });

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
      // Список допущенных перечитывается заново: снятое ограничение уносит и
      // его, а показанный после этого прежний список был бы неправдой.
      granted = null;
      await invalidateAll();
    });

  const grant = (event: SubmitEvent) => {
    event.preventDefault();
    if (!chosen) return;
    return act(async () => {
      await addPermission({ pageId, role, userIds: [chosen] });
      chosen = '';
      granted = await listPermissions(pageId);
    });
  };

  const revoke = (userId: string) =>
    act(async () => {
      await removePermission({ pageId, userIds: [userId] });
      granted = await listPermissions(pageId);
    });

  const dropLabel = (labelId: string) =>
    act(async () => {
      await detachLabel(pageId, labelId);
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
        <li class="flex items-center gap-1 rounded bg-surface px-2 py-0.5 text-xs">
          <!-- Метка это ссылка на перечень страниц с ней: иначе она украшение,
               а не способ найти соседние страницы. -->
          <a class="hover:underline" href="/labels/{encodeURIComponent(label.name)}">
            {label.name}
          </a>
          <button
            class="text-text-muted hover:text-text"
            type="button"
            disabled={busy}
            aria-label={t('Remove')}
            onclick={() => dropLabel(label.id)}
          >
            ×
          </button>
        </li>
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
        <!--
          Отсутствие сведений это не «доступ открыт всем». Запрос за правами мог
          и не дойти, а утверждение об открытом доступе на месте неизвестности
          читается как факт.
        -->
        <p class="mb-2 text-xs text-text-muted">
          {#if permission === null}
            {t('Something went wrong')}
          {:else if permission.hasDirectRestriction}
            {t('Only people listed below can access this page')}
          {:else if permission.hasInheritedRestriction}
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

        {#if permission?.hasDirectRestriction}
          <ul class="mt-3 space-y-1">
            {#each granted ?? [] as one (one.id)}
              <li class="flex items-start justify-between gap-2">
                <span class="min-w-0">
                  <span class="block truncate">{one.name ?? one.email ?? t('Unknown')}</span>
                  <span class="block text-xs text-text-muted">
                    {t(one.role === 'writer' ? 'Can edit' : 'Can view')}
                  </span>
                </span>
                {#if permission.userAccess.canManage && one.userId}
                  <button
                    class="shrink-0 text-xs text-text-muted hover:text-text"
                    type="button"
                    disabled={busy}
                    onclick={() => revoke(one.userId as string)}
                  >
                    {t('Remove')}
                  </button>
                {/if}
              </li>
            {:else}
              <li class="text-xs text-text-muted">{t('No user found')}</li>
            {/each}
          </ul>

          {#if permission.userAccess.canManage}
            <form class="mt-3 space-y-2" onsubmit={grant}>
              <select
                class="w-full rounded border border-border bg-surface px-2 py-1 text-sm"
                bind:value={chosen}
                aria-label={t('Add members')}
              >
                <option value="">{t('Add members')}</option>
                {#each candidates.filter((one) => !(granted ?? []).some((row) => row.userId === one.id)) as member (member.id)}
                  <option value={member.id}>{member.name ?? member.email}</option>
                {/each}
              </select>
              <div class="flex gap-2">
                <select
                  class="flex-1 rounded border border-border bg-surface px-2 py-1 text-sm"
                  bind:value={role}
                  aria-label={t('Access')}
                >
                  {#each ROLES as one (one.value)}
                    <option value={one.value}>{t(one.label)}</option>
                  {/each}
                </select>
                <Button type="submit" disabled={busy || !chosen}>{t('Add')}</Button>
              </div>
            </form>
          {/if}
        {/if}
      </div>

      <div>
        <p class="mb-1 font-medium">{t('Share to web')}</p>
        {#if share}
          <!--
            Ключ ссылки и есть учётные данные того, кто по ней придёт. Сервер
            отдаёт его каждому, кто вправе читать страницу: знать, что
            содержимое уходит наружу, полагается и читателю.
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
