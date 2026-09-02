<script lang="ts">
  import { page as current } from '$app/state';
  import { locale } from '$lib/stores/i18n.svelte';
  import type { NodeViewProps } from '../node-view.svelte';

  type Props = NodeViewProps;
  const { attributes }: Props = $props();

  const t = $derived(locale.t);

  const blockId = $derived(String(attributes.id ?? ''));
  let copied = $state(false);

  /**
   * Ссылка на блок для вставки в другую страницу.
   *
   * Пара «страница и блок» — всё, что нужно вставляющему: содержимое он
   * спросит у источника сам. Копируется адресом, потому что вставка идёт в
   * другой документ, а межстраничного буфера у редактора нет.
   */
  function copyReference() {
    const host = current.data?.page as { id: string } | undefined;
    if (!host || !blockId) return;
    void navigator.clipboard?.writeText(`${host.id}#${blockId}`);
    copied = true;
    setTimeout(() => (copied = false), 2000);
  }
</script>

<!--
  Содержимое блока рисует сам редактор: узел содержит настоящие узлы документа,
  и подменять их своим показом значило бы запретить их правку.
-->
<div
  data-component="TransclusionSourceView"
  class="my-3 rounded border-l-4 border-accent bg-surface-muted py-2 pl-3 pr-2"
>
  <div class="mb-1 flex items-center justify-between text-xs text-text-muted">
    <span>{t('Synced block')}</span>
    <button class="hover:underline" type="button" onclick={copyReference}>
      {copied ? t('Copied') : t('Copy synced block')}
    </button>
  </div>
  <div data-node-view-content></div>
</div>
