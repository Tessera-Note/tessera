<script lang="ts">
  import { normalizeFileUrl } from '@tessera/editor-ext';
  import { locale } from '$lib/stores/i18n.svelte';
  import type { NodeViewProps } from '../node-view.svelte';

  type Props = NodeViewProps & { kind: 'drawio' | 'excalidraw' };
  const { attributes, selected, kind }: Props = $props();

  const t = $derived(locale.t);
  const source = $derived(normalizeFileUrl(String(attributes.src ?? '')));
  const title = $derived(String(attributes.title ?? ''));
</script>

<!--
  Диаграмма хранится картинкой, а её исходник — вложением. Показывается
  картинка; правка открывается в своём редакторе, а не здесь.

  Своего редактора у второй версии пока нет: diagrams.net встраивается кадром,
  а полотно Excalidraw существует только как библиотека React. Это записано в
  `docs/future-roadmap.md`; открыть исходник ссылкой можно уже сейчас.
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
    <p class="text-sm text-text-muted">{t('Loading...')}</p>
  {/if}

  <figcaption class="mt-1 flex items-center justify-between text-xs text-text-muted">
    <span>{title || (kind === 'drawio' ? 'diagrams.net' : 'Excalidraw')}</span>
    {#if source}
      <a class="underline" href={source} target="_blank" rel="noreferrer">{t('Open')}</a>
    {/if}
  </figcaption>
</figure>
