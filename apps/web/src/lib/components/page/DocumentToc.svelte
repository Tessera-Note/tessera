<script lang="ts">
  import { headings } from '$lib/features/page/document';
  import { locale } from '$lib/stores/i18n.svelte';

  type Props = {
    /** Документ страницы в том виде, в каком его отдаёт сервер. */
    content: unknown;
    /**
     * Где показано содержимое. Внутри него ищется заголовок по счёту.
     *
     * Отдельно от документа, потому что оглавление стоит не рядом с текстом:
     * в панели сбоку и в столбце ссылки, — и найти показанное само оно не
     * может.
     */
    body?: () => HTMLElement | null;
  };
  const { content, body }: Props = $props();

  const t = $derived(locale.t);

  const entries = $derived(headings(content));

  /**
   * Какой раздел читают сейчас.
   *
   * Номер в перечне, а не сам узел: перечень строится по документу, а
   * наблюдение идёт за разметкой, и общего у них только порядок.
   */
  let active = $state(-1);

  /**
   * Заголовки показанного документа.
   *
   * Пустые пропускаются: перечень строится по документу той же меркой
   * (`headings` не берёт заголовок без текста), и без этого отбора номера
   * разошлись бы на первом же пустом заголовке — переход уводил бы не туда.
   */
  function shownHeadings(host: HTMLElement): HTMLElement[] {
    return [...host.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')].filter(
      (one) => (one.textContent ?? '').trim() !== ''
    );
  }

  /**
   * Слежение за тем, какой заголовок сейчас вверху.
   *
   * Наблюдателем пересечений, как в v1 (`table-of-contents.tsx`): опрос по
   * событию прокрутки считал бы положение каждого заголовка на каждый кадр.
   * Верхняя граница поднята под шапку, нижняя обрезает почти весь экран —
   * тогда «текущим» становится заголовок, дошедший до верха, а не любой
   * видимый.
   *
   * Пересобирается по изменениям разметки: содержимое вставляется позже самого
   * оглавления — редактор собирается отдельной загрузкой — и меняется при
   * правке. Без этого оглавление следило бы за узлами, которых уже нет.
   */
  $effect(() => {
    void entries;
    const host = body?.();
    if (!host || typeof IntersectionObserver === 'undefined') return;

    let seen: HTMLElement[] = [];
    let watcher: IntersectionObserver | null = null;

    const attach = () => {
      const found = shownHeadings(host);
      if (found.length === seen.length && found.every((one, index) => one === seen[index])) return;
      watcher?.disconnect();
      seen = found;
      active = -1;
      watcher = new IntersectionObserver(
        (records) => {
          for (const record of records) {
            if (record.isIntersecting) active = seen.indexOf(record.target as HTMLElement);
          }
        },
        { rootMargin: '-64px 0px -85% 0px', threshold: 0 }
      );
      for (const one of seen) watcher.observe(one);
    };

    attach();
    const changes = new MutationObserver(attach);
    changes.observe(host, { childList: true, subtree: true });

    return () => {
      changes.disconnect();
      watcher?.disconnect();
    };
  });

  /**
   * Перевести взгляд на заголовок.
   *
   * Ищется по порядковому номеру, а не по тексту и не по признаку: два
   * одинаковых заголовка в документе — обычное дело, а признаков у показанной
   * разметки может не быть вовсе. Порядок же в документе и в разметке один.
   */
  function jump(index: number) {
    const host = body?.();
    if (!host) return;
    shownHeadings(host)[index]?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
</script>

<nav data-component="DocumentToc">
  {#if entries.length === 0}
    <p class="text-sm text-text-muted">{t('Add headings to create a table of contents.')}</p>
  {:else}
    <ul class="space-y-1 text-sm">
      {#each entries as entry, index (index)}
        <li style:padding-left="{(Math.min(entry.level, 4) - 1) * 12}px">
          <button
            class="block w-full overflow-hidden text-ellipsis whitespace-nowrap border-l-2 pl-2 text-left"
            class:border-transparent={active !== index}
            class:text-text-muted={active !== index}
            class:border-accent={active === index}
            class:text-text={active === index}
            class:font-medium={active === index}
            type="button"
            aria-current={active === index ? 'true' : undefined}
            onclick={() => jump(index)}
          >
            {entry.text}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</nav>
