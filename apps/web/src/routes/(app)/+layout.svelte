<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import PageTree from '$lib/components/page/PageTree.svelte';
  import { logout } from '$lib/features/auth/services/auth';
  import { locale } from '$lib/stores/i18n.svelte';
  import { theme } from '$lib/stores/theme.svelte';
  import type { Snippet } from 'svelte';
  import type { LayoutData } from './$types';

  type Props = { data: LayoutData; children: Snippet };
  const { data, children }: Props = $props();

  const t = $derived(locale.t);

  async function signOut() {
    await logout();
    await invalidateAll();
    await goto('/login');
  }
</script>

<div data-section="app" class="flex min-h-screen bg-surface-muted text-text">
  <aside class="w-64 shrink-0 border-r border-border bg-surface p-4">
    <a class="mb-6 block text-lg font-semibold" href="/home">
      {data.session?.workspace.name ?? 'Tessera'}
    </a>

    <nav data-component="SpaceList" class="space-y-1">
      <a
        class="block px-2 pb-1 text-xs uppercase tracking-wide text-text-muted hover:underline"
        href="/spaces"
      >
        {t('Spaces')}
      </a>
      {#each data.spaces as space (space.id)}
        <a
          class="block truncate rounded px-2 py-1.5 text-sm hover:bg-surface-muted"
          class:font-medium={page.params.spaceSlug === space.slug}
          href="/s/{space.slug}"
        >
          {space.name ?? space.slug}
        </a>
        {#if page.params.spaceSlug === space.slug}
          <!-- Дерево показывается только у открытого пространства: остальные
               свернуты, и загружать их ветви незачем. -->
          <PageTree spaceId={space.id} spaceSlug={space.slug} />
          <a
            class="block rounded px-2 py-1 text-xs text-text-muted hover:bg-surface-muted"
            href="/s/{space.slug}/settings"
          >
            {t('Space settings')}
          </a>
        {/if}
      {:else}
        <p class="px-2 text-sm text-text-muted">{t('No spaces found')}</p>
      {/each}
    </nav>

    <nav class="mt-6 space-y-1 border-t border-border pt-4 text-sm">
      <a class="block rounded px-2 py-1.5 hover:bg-surface-muted" href="/search">{t('Search')}</a>
      <a class="block rounded px-2 py-1.5 hover:bg-surface-muted" href="/favorites">
        {t('Favorites')}
      </a>
      <a
        class="flex items-center justify-between rounded px-2 py-1.5 hover:bg-surface-muted"
        href="/notifications"
      >
        {t('Notifications')}
        {#if data.unread > 0}
          <span class="rounded-full bg-accent px-2 py-0.5 text-xs text-accent-text">
            {data.unread}
          </span>
        {/if}
      </a>
      <a class="block rounded px-2 py-1.5 hover:bg-surface-muted" href="/settings/account">
        {t('Settings')}
      </a>
    </nav>

    <div class="mt-6 border-t border-border pt-4 text-sm">
      <p class="truncate px-2 text-text-muted">{data.session?.user.email}</p>
      <button
        class="mt-2 w-full rounded px-2 py-1.5 text-left hover:bg-surface-muted"
        onclick={() => theme.toggle()}
      >
        {theme.current === 'dark' ? t('Light mode') : t('Dark mode')}
      </button>
      <button class="w-full rounded px-2 py-1.5 text-left hover:bg-surface-muted" onclick={signOut}>
        {t('Logout')}
      </button>
    </div>
  </aside>

  <main class="min-w-0 flex-1 p-8">
    {@render children()}
  </main>
</div>
