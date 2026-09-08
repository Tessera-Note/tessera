<script lang="ts">
  import type { Snippet } from 'svelte';

  type Props = { children: Snippet };
  const { children }: Props = $props();
</script>

<!--
  Разделы настроек живут в боковой панели приложения, как в v1: панель одна и
  меняет состав по разделу. Здесь остаётся только само содержимое.
-->
<div data-section="settings" class="min-w-0">{@render children()}</div>
