<script lang="ts">
  import { IconDots } from '@tabler/icons-svelte';
  import { locale } from '$lib/stores/i18n.svelte';

  type Crumb = { id: string; slugId: string; title: string | null };

  type Props = {
    crumbs: Crumb[];
    spaceSlug: string;
  };
  const { crumbs, spaceSlug }: Props = $props();

  const t = $derived(locale.t);

  /**
   * Длинная цепочка сворачивается, а не ужимается.
   *
   * Ветвь ввезённой выгрузки бывает в семь уровней, и каждое название,
   * обрезанное до своей доли ширины, превращается в «Pr… / M… / AOS:…» —
   * прочесть нельзя ни одно. В v1 показаны первое и последнее, а середина
   * убрана под кнопку (`features/page/components/breadcrumbs/breadcrumb.tsx`).
   */
  const LIMIT = 3;

  const shown = $derived(crumbs.length > LIMIT ? [crumbs[0], crumbs[crumbs.length - 1]] : crumbs);
  const hidden = $derived(crumbs.length > LIMIT ? crumbs.slice(1, -1) : []);

  let opened = $state(false);
</script>

{#if crumbs.length > 1}
  <nav
    data-component="Breadcrumbs"
    class="relative flex min-w-0 items-center gap-1 text-sm text-text-muted"
    aria-label={t('Breadcrumb')}
  >
    <a
      class="max-w-[200px] truncate hover:underline"
      href="/s/{spaceSlug}/p/{shown[0].slugId}"
      title={shown[0].title ?? t('Untitled')}
    >
      {shown[0].title ?? t('Untitled')}
    </a>

    {#if hidden.length > 0}
      <span aria-hidden="true">/</span>
      <button
        class="flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-surface-hover"
        type="button"
        aria-label={t('Show hidden breadcrumbs')}
        aria-expanded={opened}
        onclick={() => (opened = !opened)}
      >
        <IconDots size={16} stroke={1.7} />
      </button>
      {#if opened}
        <div
          class="absolute left-0 top-8 z-40 max-h-64 w-64 overflow-y-auto rounded-md border border-border bg-surface-raised py-1 shadow-lg"
          role="menu"
        >
          {#each hidden as crumb (crumb.id)}
            <a
              class="block truncate px-3 py-1.5 text-sm text-text hover:bg-surface-hover"
              role="menuitem"
              href="/s/{spaceSlug}/p/{crumb.slugId}"
              onclick={() => (opened = false)}
            >
              {crumb.title ?? t('Untitled')}
            </a>
          {/each}
        </div>
      {/if}
    {/if}

    {#each shown.slice(1) as crumb (crumb.id)}
      <span aria-hidden="true">/</span>
      <a
        class="max-w-[200px] truncate text-text hover:underline"
        href="/s/{spaceSlug}/p/{crumb.slugId}"
        title={crumb.title ?? t('Untitled')}
        aria-current="page"
      >
        {crumb.title ?? t('Untitled')}
      </a>
    {/each}
  </nav>
{/if}
