<script lang="ts">
  import type { Snippet } from 'svelte';

  type Props = {
    type?: 'button' | 'submit';
    variant?: 'primary' | 'quiet';
    /** Во всю ширину родителя. Так стоят кнопки на экранах входа: там форма
     *  одна, и кнопка по содержимому читается как «ещё одно поле». */
    wide?: boolean;
    disabled?: boolean;
    onclick?: () => void;
    children: Snippet;
  };
  const {
    type = 'button',
    variant = 'primary',
    wide = false,
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
  class="{wide
    ? 'flex w-full'
    : 'inline-flex'} h-9 items-center justify-center rounded px-[18px] text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 {variant ===
  'primary'
    ? 'bg-accent text-accent-text hover:bg-accent-hover'
    : 'border border-border bg-surface-raised text-text hover:bg-surface-hover'}"
  {type}
  {disabled}
  {onclick}
>
  {@render children()}
</button>
