<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import Button from '$lib/components/ui/Button.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import TextInput from '$lib/components/ui/TextInput.svelte';
  import { errorText } from '$lib/api/failure';
  import { attachLabels, detachLabel, type Label } from '$lib/features/page/services/labels';
  import { getVersion, type Version } from '$lib/features/page/services/history';
  import { plainText } from '$lib/features/page/document';
  import {
    createShare,
    revokeShare,
    updateShare,
    type Share
  } from '$lib/features/share/services/share';
  import {
    PERIOD_UNITS,
    configureVerification,
    markObsolete,
    rejectApproval,
    removeVerification,
    submitForApproval,
    verifyPage,
    type VerificationInfo
  } from '$lib/features/verification/services/page';
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
    verification: VerificationInfo | null;
    share: Share | null;
    spaceSlug: string;
  };
  const {
    pageId,
    spaceId,
    versions,
    labels,
    backlinks,
    permission,
    verification,
    share,
    spaceSlug
  }: Props = $props();

  const t = $derived(locale.t);

  /**
   * Подписи состояний проверки.
   *
   * Сервер отдаёт коды, и показывать их человеку нельзя: `pending_approval` в
   * интерфейсе читается как обрывок кода, а не как состояние. Незнакомый код
   * показывается как есть — это лучше пустоты, и такое сразу видно.
   */
  const STATUS_LABELS: Record<string, string> = {
    pending: 'Pending',
    pending_approval: 'In approval',
    verified: 'Verified',
    rejected: 'Approval rejected',
    expiring: 'Expiring',
    expired: 'Expired',
    obsolete: 'Obsolete'
  };

  let tab = $state<'history' | 'labels' | 'links' | 'access' | 'check'>('history');
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
  /** Состав пространства: пустой массив это «ещё не спрашивали». */
  let candidates = $state<SpaceMember[] | null>(null);
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
    if (tab !== 'check' || candidates !== null) return;
    void act(async () => {
      candidates = await spaceMembers(spaceId);
    });
  });

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

  // Срок проверки: сколько и в чём. Умолчание из v1 — год.
  let periodAmount = $state(1);
  let periodUnit = $state('year');
  let rejectComment = $state('');
  /** Кому подтверждать. Без них подтвердить страницу будет некому. */
  let verifierIds = $state<string[]>([]);

  const configure = () =>
    act(async () => {
      await configureVerification({
        pageId,
        periodAmount,
        periodUnit,
        verifierIds
      });
      await invalidateAll();
    });

  const runVerification = (action: () => Promise<unknown>) =>
    act(async () => {
      await action();
      await invalidateAll();
    });

  const toggleShare = () =>
    act(async () => {
      await (share ? revokeShare(pageId) : createShare({ pageId }));
      await invalidateAll();
    });

  const changeShare = (values: { includeSubPages?: boolean; searchIndexing?: boolean }) =>
    act(async () => {
      if (!share) return;
      await updateShare(share.id, values);
      await invalidateAll();
    });
</script>

<aside
  data-component="PageSidePanel"
  class="fixed bottom-0 right-0 top-header w-aside overflow-y-auto bg-surface-muted p-4"
>
  <nav class="mb-4 flex flex-wrap gap-1 text-sm">
    {#each [['history', t('Page history')], ['labels', t('Labels')], ['links', t('Backlinks')], ['access', t('Access')], ['check', t('Page verification')]] as [key, title] (key)}
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
  {:else if tab === 'check'}
    <div class="space-y-3 text-sm">
      {#if !verification}
        <!-- Сведений нет: запрос мог и не дойти, и утверждать вместо него
             «проверка не заведена» значит выдавать неизвестность за факт. -->
        <p class="text-text-muted">{t('Loading...')}</p>
      {:else if !verification.configured}
        <p class="text-text-muted">{t('No approval has been requested yet.')}</p>
        {#if verification.canManage}
          <div class="flex items-end gap-2">
            <label class="w-16">
              <span class="mb-1 block text-xs text-text-muted">{t('Number')}</span>
              <input
                class="w-full rounded border border-border-input bg-surface px-2 py-1 text-sm text-text outline-none focus:border-accent"
                type="number"
                min="1"
                bind:value={periodAmount}
              />
            </label>
            <label class="flex-1">
              <span class="mb-1 block text-xs text-text-muted">{t('Period')}</span>
              <select
                class="w-full rounded border border-border-input bg-surface px-2 py-1 text-sm text-text outline-none focus:border-accent"
                bind:value={periodUnit}
              >
                {#each PERIOD_UNITS as one (one.value)}
                  <option value={one.value}>{t(one.label)}</option>
                {/each}
              </select>
            </label>
          </div>
          <label class="block">
            <span class="mb-1 block text-xs text-text-muted">{t('Verifiers')}</span>
            <select
              class="w-full rounded border border-border-input bg-surface px-2 py-1 text-sm text-text outline-none focus:border-accent"
              multiple
              size="4"
              bind:value={verifierIds}
            >
              {#each candidates ?? [] as person (person.id)}
                <option value={person.id}>{person.name ?? person.email}</option>
              {/each}
            </select>
          </label>
          <Button disabled={busy || verifierIds.length === 0} onclick={configure}>
            {t('Set up verification')}
          </Button>
        {/if}
      {:else}
        <p>
          <span class="font-medium">{t('Status')}:</span>
          {t(STATUS_LABELS[verification.status ?? ''] ?? verification.status ?? '')}
        </p>
        {#if verification.expiresAt}
          <p class="text-text-muted">
            {t('Expires')}: {new Date(verification.expiresAt).toLocaleDateString(locale.current)}
          </p>
        {/if}
        {#if verification.rejectionComment}
          <p class="text-text-muted">{verification.rejectionComment}</p>
        {/if}

        <div class="flex flex-wrap gap-2">
          {#if verification.canVerify}
            <Button disabled={busy} onclick={() => runVerification(() => verifyPage(pageId))}>
              {t('Verify')}
            </Button>
          {/if}
          {#if verification.canSubmit}
            <Button
              variant="quiet"
              disabled={busy}
              onclick={() => runVerification(() => submitForApproval(pageId))}
            >
              {t('Submit for approval')}
            </Button>
          {/if}
          {#if verification.canVerify}
            <Button
              variant="quiet"
              disabled={busy}
              onclick={() =>
                runVerification(() => rejectApproval(pageId, rejectComment || undefined))}
            >
              {t('Reject')}
            </Button>
          {/if}
          {#if verification.canManage}
            <Button
              variant="quiet"
              disabled={busy}
              onclick={() => runVerification(() => markObsolete(pageId))}
            >
              {t('Mark obsolete')}
            </Button>
            <Button
              variant="quiet"
              disabled={busy}
              onclick={() => runVerification(() => removeVerification(pageId))}
            >
              {t('Remove verification')}
            </Button>
          {/if}
        </div>

        {#if verification.canVerify}
          <input
            class="w-full rounded border border-border-input bg-surface px-2 py-1 text-sm text-text outline-none focus:border-accent"
            bind:value={rejectComment}
            placeholder={t('Reason for returning this document...')}
          />
        {/if}
      {/if}
    </div>
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
                {#each (candidates ?? []).filter((one) => !(granted ?? []).some((row) => row.userId === one.id)) as member (member.id)}
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
          {#if permission?.userAccess.canManage}
            <!--
              Оба переключателя расширяют то, что уходит наружу, и потому
              доступны только тому, кто вправе править страницу.
            -->
            <label class="mb-1 flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                checked={share.includeSubPages}
                disabled={busy}
                onchange={(event) =>
                  changeShare({
                    includeSubPages: (event.currentTarget as HTMLInputElement).checked
                  })}
              />
              <span>{t('Include sub-pages')}</span>
            </label>
            <label class="mb-2 flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                checked={share.searchIndexing ?? false}
                disabled={busy}
                onchange={(event) =>
                  changeShare({
                    searchIndexing: (event.currentTarget as HTMLInputElement).checked
                  })}
              />
              <span>{t('Allow search engines to index page')}</span>
            </label>
          {/if}
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
