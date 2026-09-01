<script lang="ts">
  import { locale } from '$lib/stores/i18n.svelte';
  import type { NodeViewProps } from '../node-view.svelte';

  type Props = NodeViewProps;
  const { attributes, selected }: Props = $props();

  const t = $derived(locale.t);
  const pageId = $derived(attributes.pageId ? String(attributes.pageId) : null);
</script>

<!--
  Встроенная база показывается ссылкой на свой экран, а не таблицей внутри
  страницы: таблица там своя, со своими свойствами и представлениями, и второй
  её рисовальщик внутри документа разошёлся бы с первым.
-->
<div
  data-component="BaseEmbedView"
  class="my-2 rounded border border-border bg-surface-muted p-3"
  class:outline={selected}
  class:outline-2={selected}
  class:outline-accent={selected}
>
  {#if pageId}
    <a class="text-sm font-medium hover:underline" href="/base/{pageId}">
      {t('Base')}
    </a>
  {:else}
    <p class="text-sm text-text-muted">{t('Loading...')}</p>
  {/if}
</div>
