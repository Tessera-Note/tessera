<script lang="ts">
  import type { NodeViewProps } from '../node-view.svelte';

  const { attributes }: Props = $props();
  type Props = NodeViewProps;

  const label = $derived(String(attributes.label ?? attributes.entityId ?? ''));
  const isPage = $derived(attributes.entityType === 'page');
  const slug = $derived(attributes.slugId ? String(attributes.slugId) : null);
</script>

<!--
  Упоминание страницы это ссылка, упоминание человека — нет: у человека внутри
  вики своего экрана нет, и ссылка вела бы в никуда.
-->
{#if isPage && slug}
  <a
    data-component="MentionView"
    class="rounded bg-accent-soft px-1 py-0.5 text-sm text-accent no-underline"
    href="/p/{slug}"
  >
    {label}
  </a>
{:else}
  <span data-component="MentionView" class="rounded bg-accent-soft px-1 py-0.5 text-sm text-accent">
    {isPage ? '' : '@'}{label}
  </span>
{/if}
