<script lang="ts">
  import { locale } from '$lib/stores/i18n.svelte';
  import type { Favorite } from '$lib/features/page/services/favorites';
  import type { PageListing } from '$lib/features/page/services/pages';

  type Props = {
    recent: PageListing[];
    favorites: Favorite[];
    mine: PageListing[];
    /**
     * Показывать только это пространство. Пусто — все доступные.
     *
     * Свежие и созданные отбирает сервер: предел берётся до отбора, и отсев
     * здесь показывал бы пустой перечень там, где страницы есть. Избранное
     * отбирается здесь — оно приходит целиком и коротко.
     */
    spaceId?: string | null;
  };
  const { recent, favorites, mine, spaceId = null }: Props = $props();

  const t = $derived(locale.t);

  /** Строка перечня: три источника приводятся к одному виду. */
  type Row = {
    id: string;
    slugId: string;
    title: string | null;
    icon: string | null;
    spaceSlug: string;
    spaceName: string | null;
    when: string | null;
    isBase: boolean;
  };

  let tab = $state<'recent' | 'favorites' | 'mine'>('recent');

  const tabs = $derived([
    { key: 'recent' as const, label: t('Recently updated') },
    { key: 'favorites' as const, label: t('Favorites') },
    { key: 'mine' as const, label: t('Created by me') }
  ]);

  /** Дата коротко: день и месяц, а у прошлого года — с годом. */
  function shortDate(value: string | null): string | null {
    if (!value) return null;
    const at = new Date(value);
    if (Number.isNaN(at.getTime())) return null;
    const now = new Date();
    return at.toLocaleDateString(locale.current, {
      day: 'numeric',
      month: 'short',
      ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' })
    });
  }

  const shown = $derived.by((): Row[] => {
    if (tab === 'favorites') {
      return favorites
        .filter((one) => !spaceId || one.spaceId === spaceId)
        .map((one) => ({
          id: one.id,
          slugId: one.slugId,
          title: one.title,
          icon: one.icon,
          spaceSlug: one.spaceSlug,
          spaceName: one.spaceName,
          when: null,
          isBase: one.isBase === true
        }));
    }
    const source = tab === 'mine' ? mine : recent;
    return source.map((one) => ({
      id: one.id,
      slugId: one.slugId,
      title: one.title,
      icon: one.icon,
      spaceSlug: one.spaceSlug,
      spaceName: one.spaceName,
      when: shortDate(tab === 'mine' ? one.createdAt : one.updatedAt),
      isBase: one.isBase === true
    }));
  });

  const empty = $derived(
    tab === 'favorites' ? t('No favorites yet') : t('No pages match your search.')
  );
</script>

<!--
  Три перечня, как в v1 (`features/home/components/home-tabs.tsx` и
  `features/space/components/space-home-tabs.tsx` — там они одинаковы, разница
  только в отборе по пространству). Без них экран показывал одни карточки
  пространств либо плоский список корневых страниц: узнать, что происходило,
  было негде.
-->
<div data-component="PageListTabs">
  <nav class="mb-4 flex gap-1 border-b border-border text-sm">
    {#each tabs as one (one.key)}
      <button
        class="-mb-px border-b-2 px-3 py-2 font-medium transition-colors"
        class:border-accent={tab === one.key}
        class:text-text={tab === one.key}
        class:border-transparent={tab !== one.key}
        class:text-text-muted={tab !== one.key}
        type="button"
        aria-current={tab === one.key ? 'true' : undefined}
        onclick={() => (tab = one.key)}
      >
        {one.label}
      </button>
    {/each}
  </nav>

  <ul class="space-y-1">
    {#each shown as row (row.id)}
      <li>
        <a
          class="flex items-baseline justify-between gap-3 rounded px-2 py-1.5 hover:bg-surface-hover"
          href="/s/{row.spaceSlug}/p/{row.slugId}"
        >
          <span class="min-w-0 truncate text-sm">
            <!-- Значок по умолчанию свой у базы: она и открывается таблицей. -->
            <span aria-hidden="true">{row.icon ?? (row.isBase ? '🗄️' : '📄')}</span>
            {row.title ?? (row.isBase ? t('Untitled base') : t('Untitled'))}
          </span>
          <span class="shrink-0 text-xs text-text-muted">
            {row.spaceName ?? ''}{row.when ? ` · ${row.when}` : ''}
          </span>
        </a>
      </li>
    {:else}
      <li class="px-2 py-1.5 text-sm text-text-muted">{empty}</li>
    {/each}
  </ul>
</div>
