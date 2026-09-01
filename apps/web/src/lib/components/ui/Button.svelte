<script lang="ts">
  import type { Snippet } from 'svelte';

  type Props = {
    type?: 'button' | 'submit';
    variant?: 'primary' | 'quiet';
    disabled?: boolean;
    onclick?: () => void;
    children: Snippet;
  };
  const {
    type = 'button',
    variant = 'primary',
    disabled = false,
    onclick,
    children
  }: Props = $props();
</script>

<!--
  Вид кнопки повторяет Mantine из v1: высота 36, боковой отступ 18, шрифт 14,
  насыщенность 600, скругление 4. Основная — заливка основным цветом, тихая —
  вариант `default`: рамка и цвет тела.
-->
<button
  data-component="Button"
  class="inline-flex h-9 items-center justify-center rounded px-[18px] text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 {variant ===
  'primary'
    ? 'bg-accent text-accent-text hover:bg-accent-hover'
    : 'border border-border bg-surface text-text hover:bg-surface-hover'}"
  {type}
  {disabled}
  {onclick}
>
  {@render children()}
</button>
