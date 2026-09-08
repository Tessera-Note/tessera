<script lang="ts">
  import type { ComponentType } from 'svelte';

  type Props = {
    /** Значок из набора Tabler — того же, что в v1. */
    icon: ComponentType;
    /** Подпись: всплывающая и для чтения с экрана. Значок сам ничего не говорит. */
    label: string;
    active?: boolean;
    disabled?: boolean;
    onclick?: () => void;
  };
  const { icon: Icon, label, active = false, disabled = false, onclick }: Props = $props();
</script>

<button
  data-component="IconButton"
  class="flex h-8 w-8 items-center justify-center rounded text-text-muted transition-colors hover:bg-surface-hover hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
  class:bg-surface-active={active}
  class:text-text={active}
  type="button"
  title={label}
  aria-label={label}
  aria-pressed={active}
  {disabled}
  {onclick}
>
  <Icon size={18} stroke={1.7} />
</button>
