<script lang="ts">
  import { locale } from '$lib/stores/i18n.svelte';
  import { plainText } from '$lib/features/page/document';

  type Props = { content: unknown };
  const { content }: Props = $props();

  const t = $derived(locale.t);
  const text = $derived(plainText(content));
</script>

<!--
  Пока текстом. Редактор с представлениями узлов это отдельная фаза, и
  показывать до неё пустой экран хуже, чем показывать содержимое без разметки:
  по тексту видно, что страница загрузилась и права проверены.
-->
<div data-component="PageBody" class="whitespace-pre-wrap leading-relaxed">
  {#if text}
    {text}
  {:else}
    <p class="text-text-muted">{t('This page has no content yet')}</p>
  {/if}
</div>
