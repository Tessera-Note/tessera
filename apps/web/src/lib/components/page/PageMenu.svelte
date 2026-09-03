<script lang="ts">
  import { IconCopy, IconFolderSymlink, IconPlus, IconTrash } from '@tabler/icons-svelte';
  import { locale } from '$lib/stores/i18n.svelte';
  import type { Space } from '$lib/features/space/services/spaces';

  type Props = {
    /** Правка разрешена: без неё остаются только просмотровые действия. */
    canEdit: boolean;
    /** Куда можно перенести. Пустой перечень прячет перенос. */
    spaces: Space[];
    /** Пространство самой страницы: переносить в него некуда. */
    spaceId: string;
    busy: boolean;
    onsubpage: () => void;
    onduplicate: () => void;
    onmove: (spaceId: string) => void;
    ondelete: () => void;
    onclose: () => void;
  };
  const {
    canEdit,
    spaces,
    spaceId,
    busy,
    onsubpage,
    onduplicate,
    onmove,
    ondelete,
    onclose
  }: Props = $props();

  const t = $derived(locale.t);

  /** Открыт перечень пространств для переноса. */
  let moving = $state(false);

  const targets = $derived(spaces.filter((space) => space.id !== spaceId));
</script>

<!--
  Закрытие по нажатию вне меню и по Escape. Окно без такого выхода остаётся
  висеть на экране, и следующее нажатие уходит в него, а не в дерево.
-->
<svelte:window onkeydown={(event) => event.key === 'Escape' && onclose()} onpointerdown={onclose} />

<div
  data-component="PageMenu"
  class="absolute right-0 z-40 mt-1 w-56 rounded-md border border-border bg-surface-raised py-1 shadow-lg"
  role="menu"
  tabindex="-1"
  onpointerdown={(event) => event.stopPropagation()}
>
  {#if canEdit}
    <button
      class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-surface-hover"
      type="button"
      role="menuitem"
      disabled={busy}
      onclick={onsubpage}
    >
      <IconPlus size={16} stroke={1.7} />
      {t('New subpage')}
    </button>
    <button
      class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-surface-hover"
      type="button"
      role="menuitem"
      disabled={busy}
      onclick={onduplicate}
    >
      <IconCopy size={16} stroke={1.7} />
      {t('Duplicate')}
    </button>

    {#if targets.length > 0}
      <button
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-surface-hover"
        type="button"
        role="menuitem"
        aria-expanded={moving}
        disabled={busy}
        onclick={() => (moving = !moving)}
      >
        <IconFolderSymlink size={16} stroke={1.7} />
        {t('Move to space')}
      </button>
      {#if moving}
        <div class="max-h-48 overflow-y-auto border-y border-border py-1">
          {#each targets as space (space.id)}
            <button
              class="w-full truncate px-8 py-1 text-left text-sm hover:bg-surface-hover"
              type="button"
              role="menuitem"
              disabled={busy}
              onclick={() => onmove(space.id)}
            >
              {space.name}
            </button>
          {/each}
        </div>
      {/if}
    {/if}

    <button
      class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-danger hover:bg-surface-hover"
      type="button"
      role="menuitem"
      disabled={busy}
      onclick={ondelete}
    >
      <IconTrash size={16} stroke={1.7} />
      {t('Delete')}
    </button>
  {:else}
    <p class="px-3 py-1.5 text-sm text-text-muted">
      {t('You do not have permission to perform this action')}
    </p>
  {/if}
</div>
