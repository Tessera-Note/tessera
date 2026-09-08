<script lang="ts">
  import { labelColor } from '$lib/features/label/colors';
  import { theme } from '$lib/stores/theme.svelte';

  type Props = {
    name: string;
    /** Ссылка на перечень страниц с этой меткой. Пусто — просто значок. */
    href?: string | null;
    /** Что показать справа: снять метку. Пусто — ничего. */
    onremove?: (() => void) | null;
    removeLabel?: string;
  };
  const { name, href = null, onremove = null, removeLabel }: Props = $props();

  const color = $derived(labelColor(name, theme.current === 'dark' ? 'dark' : 'light'));
</script>

<!--
  Метка значком с цветом, как в v1 (`features/label/components/label-chip.tsx`).
  Цвет выводится из имени: одно и то же слово всегда одного цвета, и в перечне
  из десятка меток они различаются с одного взгляда, а не по чтению.
-->
<span
  data-component="LabelChip"
  class="inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-xs font-medium"
  style="background: {color.bg}; color: {color.fg}"
>
  <span class="h-1.5 w-1.5 shrink-0 rounded-full" style="background: {color.dot}" aria-hidden="true"
  ></span>
  {#if href}
    <a class="hover:underline" {href}>{name}</a>
  {:else}
    <span>{name}</span>
  {/if}
  {#if onremove}
    <button
      class="opacity-60 hover:opacity-100"
      type="button"
      aria-label={removeLabel ?? name}
      onclick={onremove}
    >
      ×
    </button>
  {/if}
</span>
