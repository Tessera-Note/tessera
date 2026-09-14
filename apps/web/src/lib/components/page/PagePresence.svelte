<script lang="ts">
  /**
   * Кто ещё открыл эту страницу.
   *
   * Стоит внизу листа, а не в заголовке: заголовок занят действиями над
   * страницей, и присутствие там читалось бы как ещё одна кнопка. Внизу оно
   * оказывается рядом с тем, что человек в этот момент набирает.
   *
   * Показывается только когда есть кого показать. Пустой ряд аватарок означал
   * бы «никого нет» местом на экране, и это место занималось бы всегда.
   *
   * Сведения приходят из того же awareness, что рисует чужие курсоры в тексте:
   * второй источник расходился бы с первым, и в перечне стоял бы человек,
   * курсора которого в тексте уже нет.
   */
  import { IconUsers } from '@tabler/icons-svelte';

  import Avatar from '$lib/components/ui/Avatar.svelte';
  import type { Present } from '$lib/features/editor/presence';
  import { locale } from '$lib/stores/i18n.svelte';

  type Props = {
    people: Present[];
  };
  const { people }: Props = $props();

  const t = $derived(locale.t);

  /** Сколько аватарок стоит в ряду. Дальше — счётчик: ряд не резиновый. */
  const SHOWN = 4;

  const visible = $derived(people.slice(0, SHOWN));
  const hidden = $derived(Math.max(0, people.length - SHOWN));

  let open = $state(false);

  /** Щелчок мимо закрывает перечень: так же у остальных всплывающих окон. */
  function outside(node: HTMLElement) {
    function onclick(event: MouseEvent) {
      if (!node.contains(event.target as Node)) open = false;
    }
    function onkey(event: KeyboardEvent) {
      if (event.key === 'Escape') open = false;
    }
    document.addEventListener('click', onclick, true);
    document.addEventListener('keydown', onkey);
    return {
      destroy() {
        document.removeEventListener('click', onclick, true);
        document.removeEventListener('keydown', onkey);
      }
    };
  }
</script>

{#if people.length > 0}
  <div
    data-component="PagePresence"
    class="pointer-events-none sticky bottom-4 z-20 mt-6 flex justify-end print:hidden"
    use:outside
  >
    <div class="pointer-events-auto relative">
      {#if open}
        <!--
          Перечень над кнопкой, а не под ней: кнопка стоит у нижнего края, и
          список под ней уехал бы за пределы окна.
        -->
        <div
          class="absolute bottom-11 right-0 max-h-72 w-64 overflow-y-auto rounded-md border border-border bg-surface-raised py-1 shadow-lg"
          role="menu"
        >
          <p class="px-3 pb-1 pt-1.5 text-xs font-medium text-text-muted">
            {t('On this page right now')}
          </p>
          {#each people as one (one.id)}
            <div class="flex items-center gap-2 px-3 py-1.5" role="menuitem" tabindex="-1">
              <span class="flex shrink-0 rounded-full" style="box-shadow: 0 0 0 2px {one.color}">
                <Avatar src={one.avatarUrl} name={one.name} size={24} />
              </span>
              <span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-sm">
                {one.name}
              </span>
              {#if one.tabs > 1}
                <!-- Вкладок несколько: иначе одна запись выглядит как один
                     открытый лист, а их у человека два. -->
                <span class="shrink-0 text-xs text-text-muted">
                  {t('Tabs: {{count}}', { count: one.tabs })}
                </span>
              {/if}
            </div>
          {/each}
        </div>
      {/if}

      <button
        class="flex items-center gap-1.5 rounded-full border border-border bg-surface-raised py-1 pl-2 pr-3 shadow-sm hover:bg-surface-hover"
        type="button"
        title={t('On this page right now')}
        aria-label={t('On this page right now')}
        aria-expanded={open}
        onclick={() => (open = !open)}
      >
        <span class="flex items-center">
          {#each visible as one (one.id)}
            <!--
              Аватарки заходят друг на друга: ряд из четырёх занимает место
              двух с половиной, а обвод цветом курсора связывает человека с
              его курсором в тексте.
            -->
            <span
              class="-ml-1.5 flex rounded-full first:ml-0"
              style="box-shadow: 0 0 0 2px {one.color}"
              title={one.name}
            >
              <Avatar src={one.avatarUrl} name={one.name} size={22} />
            </span>
          {/each}
        </span>
        {#if hidden > 0}
          <span class="text-xs font-medium text-text-muted">+{hidden}</span>
        {:else}
          <IconUsers size={14} class="text-text-muted" />
        {/if}
      </button>
    </div>
  </div>
{/if}
