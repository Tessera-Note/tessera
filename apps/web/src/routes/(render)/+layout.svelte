<script lang="ts">
  import type { Snippet } from 'svelte';

  type Props = { children: Snippet };
  const { children }: Props = $props();
</script>

<!--
  Оболочки здесь нет намеренно: это не экран, а лист для печати. Боковая панель
  и шапка попали бы в PDF.
-->
<div class="bg-white">{@render children()}</div>
