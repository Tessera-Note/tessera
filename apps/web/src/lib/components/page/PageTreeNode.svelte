<script lang="ts">
  import { pageTree, type PageSummary } from '$lib/features/page/services/pages';
  import { locale } from '$lib/stores/i18n.svelte';
  import PageTreeNode from './PageTreeNode.svelte';

  type Props = {
    node: PageSummary;
    spaceSlug: string;
    depth: number;
    activeSlug: string | undefined;
  };
  const { node, spaceSlug, depth, activeSlug }: Props = $props();

  let open = $state(false);
  let children = $state<PageSummary[] | null>(null);
  let loading = $state(false);

  const t = $derived(locale.t);

  /**
   * Ветвь загружается при первом раскрытии, а не вместе с деревом.
   *
   * Дерево вики бывает в тысячи страниц, и загрузка целиком означает мегабайт
   * ответа ради десятка видимых строк. Повторное раскрытие берёт уже
   * загруженное: перезапрос на каждый щелчок мигал бы содержимым.
   */
  async function toggle() {
    open = !open;
    if (!open || children !== null) return;

    loading = true;
    try {
      children = await pageTree(node.spaceId, node.id);
    } catch {
      // Отказ ветви не должен ронять дерево: остальные ветви работают.
      children = [];
    } finally {
      loading = false;
    }
  }
</script>

<div data-component="PageTreeNode" style="padding-left: {depth * 12}px">
  <div class="flex items-center gap-1">
    {#if node.hasChildren === false}
      <!-- Значка раскрытия у листа нет: он раскрывался бы в пустоту. Место
           под него остаётся, иначе строки уезжают влево и дерево рябит. -->
      <span class="w-5 shrink-0" aria-hidden="true"></span>
    {:else}
      <button
        class="w-5 shrink-0 rounded text-xs text-text-muted hover:bg-surface-muted"
        type="button"
        aria-label={open ? t('Collapse') : t('Expand')}
        aria-expanded={open}
        onclick={toggle}
      >
        {open ? '▾' : '▸'}
      </button>
    {/if}
    <a
      class="min-w-0 flex-1 truncate rounded px-1.5 py-1 text-sm hover:bg-surface-muted"
      class:font-medium={activeSlug === node.slugId}
      href="/s/{spaceSlug}/p/{node.slugId}"
    >
      <span aria-hidden="true">{node.icon ?? '📄'}</span>
      {node.title ?? t('Untitled')}
    </a>
  </div>

  {#if open}
    {#if loading}
      <p class="py-1 pl-8 text-xs text-text-muted">{t('Loading...')}</p>
    {:else if children && children.length > 0}
      {#each children as child (child.id)}
        <PageTreeNode node={child} {spaceSlug} depth={depth + 1} {activeSlug} />
      {/each}
    {:else}
      <p class="py-1 pl-8 text-xs text-text-muted">{t('No pages inside')}</p>
    {/if}
  {/if}
</div>
