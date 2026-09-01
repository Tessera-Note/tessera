<script lang="ts">
  import type { NodeViewProps } from '../node-view.svelte';

  type Props = NodeViewProps;
  const { attributes, selected }: Props = $props();

  /** Цвета состояния. Значения из v1: они же лежат в документе. */
  const TONES: Record<string, string> = {
    gray: 'bg-surface-active text-text-muted',
    blue: 'bg-sky-100 text-sky-800',
    green: 'bg-emerald-100 text-emerald-800',
    yellow: 'bg-amber-100 text-amber-900',
    red: 'bg-rose-100 text-rose-800',
    purple: 'bg-accent-soft text-accent'
  };

  const tone = $derived(TONES[String(attributes.color ?? 'gray')] ?? TONES.gray);
</script>

<span
  data-component="StatusView"
  class="rounded px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide {tone}"
  class:outline={selected}
  class:outline-1={selected}
  class:outline-accent={selected}
>
  {attributes.text ?? ''}
</span>
