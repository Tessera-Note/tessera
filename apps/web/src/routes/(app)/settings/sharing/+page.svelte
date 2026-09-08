<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import Avatar from '$lib/components/ui/Avatar.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Confirm from '$lib/components/ui/Confirm.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import { errorText } from '$lib/api/failure';
  import { revokeShare } from '$lib/features/share/services/share';
  import { listShares, type ShareRow } from '$lib/features/share/services/list';
  import { locale } from '$lib/stores/i18n.svelte';
  import type { PageData } from './$types';

  type Props = { data: PageData };
  const { data }: Props = $props();

  const t = $derived(locale.t);

  let busy = $state<string | null>(null);
  let failure = $state<string | null>(null);

  /**
   * Догруженные страницы перечня.
   *
   * Страница бывает короче запрошенной: права выбрасывают строки уже после
   * выборки. Поэтому конец перечня показывает пустой курсор, а не короткая
   * страница.
   */
  let more = $state<ShareRow[]>([]);
  let cursor = $state<string | null>(null);
  let loading = $state(false);
  const shares = $derived([...data.shares, ...more]);

  $effect(() => {
    // Своё состояние сбрасывается вместе с перезагрузкой: отозванная ссылка
    // ушла из перечня, и догруженное относилось к прежнему составу.
    void data.shares;
    more = [];
    cursor = data.nextCursor;
  });

  async function loadMore() {
    if (!cursor) return;
    loading = true;
    failure = null;
    try {
      const next = await listShares({ cursor });
      more = [...more, ...next.items];
      cursor = next.meta.nextCursor;
    } catch (error) {
      failure = errorText(error, t);
    } finally {
      loading = false;
    }
  }

  /** Дата в языке человека. */
  const when = $derived((value: string | null | undefined) =>
    value
      ? new Intl.DateTimeFormat(locale.current, { dateStyle: 'medium' }).format(new Date(value))
      : '—'
  );

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
    {#each shares as share (share.id)}
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
            <!-- Сама ссылка, а не её текст: экран заводят затем, чтобы
                 посмотреть, что видит посторонний. -->
            <a
              class="mt-1 block break-all rounded bg-surface px-2 py-1 text-xs hover:underline"
              href="/share/{share.key}"
              target="_blank"
              rel="noopener"
            >
              /share/{share.key}
            </a>
            {#if share.includeSubPages}
              <p class="mt-1 text-xs text-text-muted">{t('Include subpages')}</p>
            {/if}
            <!-- Кто открыл наружу и когда. Без этого судить о строке нельзя:
                 страница названа, а решение по ней принять не по чему. -->
            <p class="mt-2 flex items-center gap-1.5 text-xs text-text-muted">
              <Avatar name={share.creatorName} src={share.creatorAvatarUrl} size={18} />
              <span class="truncate">{share.creatorName ?? t('Unknown')}</span>
              <span aria-hidden="true">·</span>
              <span>{when(share.createdAt)}</span>
            </p>
          </div>
          <!-- Отзыв необратим: прежний ключ после него не заработает, и
               разосланная ссылка перестаёт открываться у всех сразу. -->
          <Confirm
            label={t('Delete share')}
            question={t('This action cannot be undone.')}
            disabled={busy === share.pageId}
            onconfirm={() => revoke(share.pageId)}
          />
        </div>
      </li>
    {:else}
      <li class="text-sm text-text-muted">{t('No shared pages')}</li>
    {/each}
  </ul>

  {#if cursor}
    <!-- Без продолжения перечень обрывался бы на потолке выдачи, и молча. -->
    <div class="mt-4">
      <Button variant="quiet" disabled={loading} onclick={loadMore}>
        {loading ? t('Loading...') : t('Load more')}
      </Button>
    </div>
  {/if}
</section>
