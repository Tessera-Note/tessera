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
  Основная кнопка — заливка сиреневым, тихая — та же форма без заливки, с едва
  заметной границей. Высота и отступы прежние: они выверены расстановкой, менять
  их вместе с цветом незачем.
-->
<button
  data-component="Button"
  class="inline-flex h-9 items-center justify-center rounded px-[18px] text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 {variant ===
  'primary'
    ? 'bg-accent text-accent-text hover:bg-accent-hover'
    : 'border border-border bg-surface-raised text-text hover:bg-surface-hover'}"
  {type}
  {disabled}
  {onclick}
>
  {@render children()}
</button>
