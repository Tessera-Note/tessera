<script lang="ts">
  import { normalizeFileUrl } from '@tessera/editor-ext';
  import { locale } from '$lib/stores/i18n.svelte';
  import type { NodeViewProps } from '../node-view.svelte';

  type Props = NodeViewProps & {
    /** Чем показывать: картинкой, видео, звуком или встроенным документом. */
    kind: 'image' | 'video' | 'audio' | 'pdf';
  };
  const { attributes, selected, editable, updateAttributes, kind }: Props = $props();

  const t = $derived(locale.t);

  const source = $derived(normalizeFileUrl(String(attributes.src ?? '')));
  const alt = $derived(String(attributes.alt ?? ''));
  const align = $derived(String(attributes.align ?? 'center'));
  const width = $derived(attributes.width as number | string | null);

  /**
   * Изменение ширины перетаскиванием.
   *
   * Ширина пишется в узел, а не в стиль обёртки: она часть документа, и второй
   * человек должен увидеть её у себя. Пишется по отпусканию, а не по каждому
   * движению мыши — иначе на каждое движение уходит правка в общий документ.
   */
  let dragging = $state(false);
  let host: HTMLElement;

  function startResize(event: PointerEvent) {
    if (!editable) return;
    event.preventDefault();
    dragging = true;

    const startX = event.clientX;
    const startWidth = host.getBoundingClientRect().width;
    let latest = startWidth;

    function move(step: PointerEvent) {
      latest = Math.max(120, startWidth + (step.clientX - startX));
      host.style.width = `${latest}px`;
    }

    function stop() {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      dragging = false;
      host.style.width = '';
      updateAttributes({ width: Math.round(latest) });
    }

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
  }
</script>

<figure
  bind:this={host}
  data-component="MediaView"
  class="relative my-2 inline-block max-w-full rounded"
  class:outline={selected}
  class:outline-2={selected}
  class:outline-accent={selected}
  style:width={width ? (typeof width === 'number' ? `${width}px` : width) : undefined}
  style:margin-left={align === 'center' || align === 'right' ? 'auto' : undefined}
  style:margin-right={align === 'center' || align === 'left' ? 'auto' : undefined}
>
  {#if !source}
    <p class="rounded border border-border bg-surface-muted p-3 text-sm text-text-muted">
      {t('Loading...')}
    </p>
  {:else if kind === 'image'}
    <img class="block w-full rounded" src={source} {alt} />
  {:else if kind === 'video'}
    <!-- svelte-ignore a11y_media_has_caption -->
    <video class="block w-full rounded" src={source} controls aria-label={alt}></video>
  {:else if kind === 'audio'}
    <audio class="block w-full" src={source} controls aria-label={alt}></audio>
  {:else}
    <object class="block h-[640px] w-full rounded" data={source} type="application/pdf" title={alt}>
      <a class="text-sm underline" href={source}>{t('Download')}</a>
    </object>
  {/if}

  {#if editable && (kind === 'image' || kind === 'video' || kind === 'pdf')}
    <!--
      Ручка ширины. Отдельным элементом, а не рамкой у картинки: у видео и
      документа своя разметка, и рамка у них перекрывала бы управление
      воспроизведением.
    -->
    <button
      class="absolute bottom-1 right-1 h-4 w-4 cursor-ew-resize rounded-sm border border-border bg-surface-raised opacity-70 hover:opacity-100"
      class:opacity-100={dragging}
      type="button"
      aria-label={t('Full width')}
      onpointerdown={startResize}
    ></button>
  {/if}
</figure>
