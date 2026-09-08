<script lang="ts">
  /**
   * Узел упоминания в документе.
   *
   * Показ общий с телом комментария (`MentionChip`): здесь только перевод
   * атрибутов узла в его доводы. Второй показ означал бы, что имя удалённого
   * убрано на странице, но осталось в обсуждении под ней.
   */
  import MentionChip from '$lib/components/page/MentionChip.svelte';
  import type { NodeViewProps } from '../node-view.svelte';

  const { attributes }: Props = $props();
  type Props = NodeViewProps;

  const label = $derived(String(attributes.label ?? attributes.entityId ?? ''));
  const page = $derived(attributes.entityType === 'page');
  const entityId = $derived(attributes.entityId ? String(attributes.entityId) : null);
  const slugId = $derived(attributes.slugId ? String(attributes.slugId) : null);
  const anchorId = $derived(attributes.anchorId ? String(attributes.anchorId) : null);
</script>

<MentionChip {page} {label} {entityId} {slugId} {anchorId} />
