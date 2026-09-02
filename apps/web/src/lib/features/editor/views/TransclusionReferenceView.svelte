<script lang="ts">
  import { page as current } from '$app/state';
  import DocumentView from '../DocumentView.svelte';
  import { errorText } from '$lib/api/failure';
  import {
    lookupSharedTransclusions,
    lookupTransclusions,
    transclusionReferences,
    unsyncReference,
    type LookupItem,
    type ReferencePlace
  } from '$lib/features/transclusion/services/transclusion';
  import { locale } from '$lib/stores/i18n.svelte';
  import type { NodeViewProps } from '../node-view.svelte';

  type Props = NodeViewProps;
  const { attributes, editable, editor, node, position }: Props = $props();

  const t = $derived(locale.t);

  const sourcePageId = $derived(String(attributes.sourcePageId ?? ''));
  const transclusionId = $derived(String(attributes.transclusionId ?? ''));

  let found = $state<LookupItem | null>(null);
  let failure = $state<string | null>(null);
  let places = $state<ReferencePlace[] | null>(null);
  let busy = $state(false);

  /**
   * Содержимое блока не хранится в документе, а спрашивается у источника.
   *
   * В этом и смысл включения: правка источника видна всюду сразу. Записанный
   * однажды снимок разошёлся бы с ним при первой же правке, и заметить это по
   * экрану было бы нельзя.
   */
  $effect(() => {
    if (!sourcePageId || !transclusionId || found !== null) return;

    void (async () => {
      try {
        // Страница, открытая по ссылке, спрашивает своим маршрутом: там нет
        // человека, и доступ задаёт ветвь публикации.
        const key = current.params?.key;
        const answer = key
          ? await lookupSharedTransclusions(key, [{ sourcePageId, transclusionId }])
          : await lookupTransclusions([{ sourcePageId, transclusionId }]);
        found = answer.items[0] ?? { sourcePageId, transclusionId, status: 'not_found' };
      } catch (error) {
        failure = errorText(error, t);
      }
    })();
  });

  async function showPlaces() {
    if (places !== null) {
      places = null;
      return;
    }
    busy = true;
    try {
      const answer = await transclusionReferences({ sourcePageId, transclusionId });
      places = answer.references;
    } catch (error) {
      failure = errorText(error, t);
    } finally {
      busy = false;
    }
  }

  /**
   * Отвязать блок.
   *
   * Содержимое приходит с сервера и вставляется на место узла ссылки самим
   * редактором: документ живёт в общем сеансе правки, и запись мимо него
   * разошлась бы с тем, что видят соседи.
   */
  async function unsync() {
    const host = current.data?.page as { id: string } | undefined;
    if (!host) return;

    busy = true;
    failure = null;
    try {
      const answer = await unsyncReference({
        referencePageId: host.id,
        sourcePageId,
        transclusionId
      });
      // Заменяется именно этот узел, а не выделение: выделение может быть где
      // угодно, и содержимое ушло бы не на место ссылки.
      const at = position();
      if (at === undefined) return;
      editor
        .chain()
        .focus()
        .insertContentAt({ from: at, to: at + node.nodeSize }, answer.content as never)
        .run();
    } catch (error) {
      failure = errorText(error, t);
    } finally {
      busy = false;
    }
  }
</script>

<div
  data-component="TransclusionReferenceView"
  class="my-3 rounded border border-dashed border-border bg-surface-muted p-3"
>
  {#if failure}
    <p class="text-sm text-danger">{failure}</p>
  {:else if found === null}
    <p class="text-sm text-text-muted">{t('Loading...')}</p>
  {:else if found.status === 'no_access'}
    <p class="text-sm text-text-muted">
      {t("You don't have access to this synced block")}
    </p>
  {:else if found.status === 'not_found'}
    <p class="text-sm text-text-muted">{t('The original synced block no longer exists')}</p>
  {:else}
    <DocumentView content={found.content} />
  {/if}

  <div class="mt-2 flex flex-wrap items-center gap-3 text-xs text-text-muted">
    <span>{t('Synced block')}</span>
    <button class="hover:underline" type="button" disabled={busy} onclick={showPlaces}>
      {places === null ? t('Synced to') : t('Close')}
    </button>
    {#if editable && found?.content}
      <button class="hover:underline" type="button" disabled={busy} onclick={unsync}>
        {t('Unsync')}
      </button>
    {/if}
  </div>

  {#if places}
    <ul class="mt-2 space-y-0.5 text-xs">
      {#each places as one (one.id)}
        <li>
          <a class="hover:underline" href="/s/{one.spaceSlug}/p/{one.slugId}">
            {one.title ?? t('Untitled')}
          </a>
        </li>
      {:else}
        <li class="text-text-muted">{t('No pages')}</li>
      {/each}
    </ul>
  {/if}
</div>
