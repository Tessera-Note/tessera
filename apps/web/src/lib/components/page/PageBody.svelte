<script lang="ts">
  import DocumentView from '$lib/features/editor/DocumentView.svelte';

  type Props = { content: unknown };
  const { content }: Props = $props();
</script>

<!--
  Показ документа теми же расширениями, что и правка: иначе картинки, таблицы и
  диаграммы на странице по ссылке и в печати превращаются в голый текст. Пока
  редактор грузится — и если не загрузится вовсе — показывается текст: пустая
  страница читалась бы как потерянное содержимое.
-->
<div data-component="PageBody">
  <DocumentView {content} />
</div>
