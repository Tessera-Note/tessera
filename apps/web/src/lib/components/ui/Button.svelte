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

<button
  data-component="Button"
  class="rounded px-3 py-2 font-medium disabled:opacity-60 {variant === 'primary'
    ? 'bg-accent text-accent-text'
    : 'border border-border bg-surface hover:bg-surface-muted'}"
  {type}
  {disabled}
  {onclick}
>
  {@render children()}
</button>
