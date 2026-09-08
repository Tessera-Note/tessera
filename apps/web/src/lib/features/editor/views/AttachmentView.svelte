<script lang="ts">
  import {
    mediaErrorMessage,
    normalizeFileUrl,
    resolveMediaErrorStatus
  } from '@tessera/editor-ext';
  import { IconDownload, IconFileTypePdf, IconLoader2, IconPaperclip } from '@tabler/icons-svelte';
  import { attachmentInfo, formatBytes } from '$lib/features/page/services/attachments';
  import { locale } from '$lib/stores/i18n.svelte';
  import type { NodeViewProps } from '../node-view.svelte';

  type Props = NodeViewProps;
  const { node, attributes, selected, editable, editor, position }: Props = $props();

  const t = $derived(locale.t);

  const url = $derived(String(attributes.url ?? ''));
  const name = $derived(String(attributes.name ?? ''));
  const size = $derived(attributes.size as number | null);
  const mime = $derived(String(attributes.mime ?? ''));
  const attachmentId = $derived(String(attributes.attachmentId ?? ''));

  /** Файл ещё грузится: узел уже в документе, адреса пока нет. */
  const loading = $derived(!url && Boolean(attributes.placeholder));

  const isPdf = $derived(mime === 'application/pdf' || name.toLowerCase().endsWith('.pdf'));

  /**
   * Попадёт ли файл в поиск.
   *
   * Спрашивается у сервера по требованию и один раз на вложение: правило
   * разбора живёт там, а держать второй его список здесь значило бы обещать
   * поиск по файлам, которые в него не попадают.
   */
  let searchable = $state<string | null>(null);
  $effect(() => {
    if (!url || !attachmentId) return;
    void attachmentInfo(attachmentId)
      .then((found) => (searchable = found.indexStatus ?? null))
      .catch(() => {
        // Отказ здесь ничего не решает: карточка показывает файл и без отметки.
      });
  });

  let failure = $state<string | null>(null);

  /**
   * Скачивание с проверкой до перехода.
   *
   * Прямая ссылка на удалённое вложение открывала бы в новой вкладке отказ
   * сервера как есть; причина проверяется здесь и называется словами.
   */
  async function download(event: MouseEvent) {
    event.preventDefault();
    if (!url) return;

    const address = normalizeFileUrl(url);
    // Проверка тем же способом, что и у остальных вложений: запрос `GET`, а не
    // `HEAD` — выдача файла отвечает только на `GET`, и `HEAD` вернул бы 405 на
    // живой файл, то есть отказ на месте успеха.
    const status = await resolveMediaErrorStatus(address);

    if (status !== undefined && status < 400) {
      failure = null;
      window.open(address, '_blank', 'noopener');
      return;
    }
    failure = mediaErrorMessage(status);
  }

  /**
   * Показать PDF прямо на странице.
   *
   * Узел заменяется целиком: встроенный просмотр это другой узел схемы, а не
   * вид того же вложения.
   */
  function embed() {
    const at = position();
    if (at === undefined || !url) return;
    editor
      .chain()
      .insertContentAt(
        { from: at, to: at + node.nodeSize },
        { type: 'pdf', attrs: { src: url, name, attachmentId, size } }
      )
      .run();
  }
</script>

<div
  data-component="AttachmentView"
  class="flex items-center gap-2 rounded-md border border-border bg-surface-raised px-2 py-1.5"
  class:outline={selected}
  class:outline-1={selected}
  class:outline-accent={selected}
>
  <span class="shrink-0 text-text-muted">
    {#if loading}
      <IconLoader2 size={18} stroke={1.7} class="animate-spin" />
    {:else}
      <IconPaperclip size={18} stroke={1.7} />
    {/if}
  </span>

  <span class="min-w-0 flex-1 truncate text-sm text-text">
    {loading ? t('Uploading {{name}}', { name }) : name}
  </span>

  <span class="shrink-0 text-xs text-text-muted">{formatBytes(size)}</span>

  {#if searchable === 'unsupported'}
    <span
      class="shrink-0 text-xs text-text-muted"
      title={t(
        'Text could not be extracted from this file, so search will not find it by content.'
      )}
    >
      {t('not searchable')}
    </span>
  {/if}

  {#if url}
    {#if isPdf && editable}
      <button
        class="flex h-7 w-7 shrink-0 items-center justify-center rounded text-text-muted hover:bg-surface-hover hover:text-text"
        type="button"
        title={t('Embed as PDF')}
        aria-label={t('Embed as PDF')}
        onclick={embed}
      >
        <IconFileTypePdf size={17} stroke={1.7} />
      </button>
    {/if}
    <a
      class="flex h-7 w-7 shrink-0 items-center justify-center rounded text-text-muted hover:bg-surface-hover hover:text-text"
      href={normalizeFileUrl(url)}
      target="_blank"
      rel="noopener"
      title={t('Download')}
      aria-label={t('Download')}
      onclick={download}
    >
      <IconDownload size={17} stroke={1.7} />
    </a>
  {/if}
</div>

{#if failure}
  <p class="mt-1 text-xs text-danger" role="alert">{failure}</p>
{/if}
