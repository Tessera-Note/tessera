<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { locale } from '$lib/stores/i18n.svelte';
  import { theme } from '$lib/stores/theme.svelte';
  import type { Snippet } from 'svelte';
  import type { LayoutData } from './$types';

  type Props = { data: LayoutData; children: Snippet };
  const { data, children }: Props = $props();

  // Язык и словарь приходят загрузчиком слоя, то есть до первой отрисовки.
  // Присваивание в эффекте, а не рядом: смена языка меняет данные слоя, и
  // разовое присваивание оставило бы на экране прежний словарь.
  $effect(() => {
    locale.apply(data.locale, data.dictionary);
  });

  onMount(() => {
    theme.hydrate();
  });
</script>

{@render children()}
