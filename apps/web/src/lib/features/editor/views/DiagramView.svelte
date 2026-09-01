<script lang="ts">
  import { normalizeFileUrl } from '@tessera/editor-ext';
  import { page as current } from '$app/state';
  import { attachmentUrl, uploadPageFile } from '$lib/features/page/services/attachments';
  import { locale } from '$lib/stores/i18n.svelte';
  import DrawioEditor from './DrawioEditor.svelte';
  import ExcalidrawEditor from './ExcalidrawEditor.svelte';
  import type { NodeViewProps } from '../node-view.svelte';

  type Props = NodeViewProps & { kind: 'drawio' | 'excalidraw' };
  const { attributes, selected, editable, updateAttributes, kind }: Props = $props();

  const t = $derived(locale.t);
  const source = $derived(normalizeFileUrl(String(attributes.src ?? '')));
  const title = $derived(String(attributes.title ?? ''));

  let open = $state(false);
  let content = $state('');
  let busy = $state(false);
  let failure = $state<string | null>(null);

  /**
   * Открыть редактор.
   *
   * Диаграмма хранится картинкой со встроенным исходником: разметка diagrams.net
   * и сцена Excalidraw лежат внутри того же SVG. Поэтому перед правкой файл
   * читается целиком, а не берётся из узла — в узле только адрес.
   */
  async function edit() {
    if (!editable || busy) return;
    busy = true;
    failure = null;
    try {
      content = source ? await (await fetch(source)).text() : '';
      open = true;
    } catch {
      failure = t('Something went wrong');
    } finally {
      busy = false;
    }
  }

  /**
   * Сохранить.
   *
   * Файл перезаписывается на месте: на вложение ссылается сам узел, и новое
   * вложение на каждое сохранение оставляло бы в хранилище мёртвые файлы.
   */
  async function keep(svg: string) {
    const pageId = (current.data?.page as { id?: string } | undefined)?.id;
    if (!pageId) return;

    const name = kind === 'drawio' ? 'diagram.drawio.svg' : 'diagram.excalidraw.svg';
    const file = new File([svg], name, { type: 'image/svg+xml' });
    const attachmentId = attributes.attachmentId ? String(attributes.attachmentId) : undefined;

    const attachment = await uploadPageFile(file, pageId, attachmentId);
    updateAttributes({
      src: attachmentUrl(attachment),
      title: attachment.fileName,
      size: attachment.fileSize,
      attachmentId: attachment.id
    });
  }

  /** Разметка diagrams.net приходит из редактора в base64 внутри `data:`. */
  function decode(value: string): string {
    const marker = 'base64,';
    const at = value.indexOf(marker);
    if (at < 0) return value;
    const binary = atob(value.slice(at + marker.length));
    return new TextDecoder().decode(Uint8Array.from(binary, (one) => one.charCodeAt(0)));
  }
</script>

<!--
  Диаграмма хранится картинкой со встроенным исходником. Показывается картинка;
  правка открывается в своём редакторе поверх страницы.
-->
<figure
  data-component="DiagramView"
  class="my-2 rounded border border-border p-2"
  class:outline={selected}
  class:outline-2={selected}
  class:outline-accent={selected}
>
  {#if source}
    <img class="block max-w-full rounded" src={source} alt={title || kind} />
  {:else}
    <p class="text-sm text-text-muted">{t('Diagrams')}</p>
  {/if}

  <figcaption class="mt-1 flex items-center justify-between text-xs text-text-muted">
    <span>{title || (kind === 'drawio' ? 'diagrams.net' : 'Excalidraw')}</span>
    <span class="flex items-center gap-2">
      {#if failure}<span class="text-danger">{failure}</span>{/if}
      {#if editable}
        <button class="underline" type="button" disabled={busy} onclick={edit}>
          {t('Edit')}
        </button>
      {/if}
      {#if source}
        <a class="underline" href={source} target="_blank" rel="noreferrer">{t('Open')}</a>
      {/if}
    </span>
  </figcaption>
</figure>

{#if open && kind === 'drawio'}
  <DrawioEditor xml={content} save={(data) => keep(decode(data))} close={() => (open = false)} />
{:else if open}
  <ExcalidrawEditor svg={content} save={keep} close={() => (open = false)} />
{/if}
