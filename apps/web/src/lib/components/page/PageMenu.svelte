<script lang="ts">
  import {
    IconCopy,
    IconFolderSymlink,
    IconLink,
    IconPlus,
    IconStar,
    IconStarFilled,
    IconTrash
  } from '@tabler/icons-svelte';
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
    /** Отмечена ли страница избранным. Звезда закрашивается по нему. */
    favorite: boolean;
    onsubpage: () => void;
    onduplicate: () => void;
    /** Копия в другое пространство. Отдельно от переноса: та страница остаётся. */
    oncopy: (spaceId: string) => void;
    onmove: (spaceId: string) => void;
    onfavorite: () => void;
    oncopylink: () => void;
    ondelete: () => void;
    onclose: () => void;
  };
  const {
    canEdit,
    spaces,
    spaceId,
    busy,
    favorite,
    onsubpage,
    onduplicate,
    oncopy,
    onmove,
    onfavorite,
    oncopylink,
    ondelete,
    onclose
  }: Props = $props();

  const t = $derived(locale.t);

  /** Открыт перечень пространств для переноса или для копии. */
  let moving = $state(false);
  let copying = $state(false);
  /** Задан вопрос об удалении. Пункт меню при этом заменяется на вопрос. */
  let asking = $state(false);

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
  <!--
    Отметка и ссылка доступны и читателю: ни та, ни другая страницу не меняют.
    Всё остальное ниже — правка, и её у читателя нет.
  -->
  <button
    class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-surface-hover"
    type="button"
    role="menuitem"
    disabled={busy}
    onclick={onfavorite}
  >
    {#if favorite}
      <IconStarFilled size={16} />
    {:else}
      <IconStar size={16} stroke={1.7} />
    {/if}
    {favorite ? t('Remove from favorites') : t('Add to favorites')}
  </button>
  <button
    class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-surface-hover"
    type="button"
    role="menuitem"
    disabled={busy}
    onclick={oncopylink}
  >
    <IconLink size={16} stroke={1.7} />
    {t('Copy link')}
  </button>

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
        aria-expanded={copying}
        disabled={busy}
        onclick={() => {
          copying = !copying;
          moving = false;
        }}
      >
        <IconCopy size={16} stroke={1.7} />
        {t('Copy to space')}
      </button>
      {#if copying}
        <div class="max-h-48 overflow-y-auto border-y border-border py-1">
          {#each targets as space (space.id)}
            <button
              class="w-full truncate px-8 py-1 text-left text-sm hover:bg-surface-hover"
              type="button"
              role="menuitem"
              disabled={busy}
              onclick={() => oncopy(space.id)}
            >
              {space.name}
            </button>
          {/each}
        </div>
      {/if}

      <button
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-surface-hover"
        type="button"
        role="menuitem"
        aria-expanded={moving}
        disabled={busy}
        onclick={() => {
          moving = !moving;
          copying = false;
        }}
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

    <!--
      Удаление спрашивает. Пункт стоит последним в меню, соседи выше безобидны,
      и промах уносил бы страницу вместе с потомками одним нажатием. Вопрос
      задаётся тут же, а не окном поверх: меню закрывается нажатием вне себя, и
      окно закрывало бы само меню, из которого вышло.
    -->
    {#if asking}
      <div class="px-3 py-1.5">
        <!--
          Только вопрос, без срока хранения: срок настраивается в рабочем
          пространстве (`settings/workspace`), меню дерева его не знает, и
          названное здесь число было бы неправдой при другой настройке.
        -->
        <p class="mb-2 text-sm text-danger">{t('Move this page to trash?')}</p>
        <div class="flex gap-2">
          <button
            class="rounded px-2 py-1 text-sm text-danger hover:bg-surface-hover"
            type="button"
            disabled={busy}
            onclick={() => {
              asking = false;
              ondelete();
            }}
          >
            {t('Move to trash')}
          </button>
          <button
            class="rounded px-2 py-1 text-sm text-text-muted hover:bg-surface-hover hover:text-text"
            type="button"
            onclick={() => (asking = false)}
          >
            {t('Cancel')}
          </button>
        </div>
      </div>
    {:else}
      <button
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-danger hover:bg-surface-hover"
        type="button"
        role="menuitem"
        disabled={busy}
        onclick={() => (asking = true)}
      >
        <IconTrash size={16} stroke={1.7} />
        {t('Delete')}
      </button>
    {/if}
  {:else}
    <!-- Читателю остаются отметка и ссылка выше, а здесь названа причина:
         пустое место под ними читается как поломка меню. -->
    <p class="px-3 py-1.5 text-sm text-text-muted">
      {t('You do not have permission to perform this action')}
    </p>
  {/if}
</div>
