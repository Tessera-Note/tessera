<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import { onRealtime } from '$lib/features/realtime/socket';
  import PageTree from '$lib/components/page/PageTree.svelte';
  import { errorText } from '$lib/api/failure';
  import Confirm from '$lib/components/ui/Confirm.svelte';
  import { chatDate, groupChatsByAge } from '$lib/features/ai/grouping';
  import {
    deleteChat,
    listChats,
    renameChat,
    searchChats,
    type Chat
  } from '$lib/features/ai/services/chat';
  import { logout } from '$lib/features/auth/services/auth';
  import { locale } from '$lib/stores/i18n.svelte';
  import { theme } from '$lib/stores/theme.svelte';
  import type { Snippet } from 'svelte';
  import type { LayoutData } from './$types';

  type Props = { data: LayoutData; children: Snippet };
  const { data, children }: Props = $props();

  const t = $derived(locale.t);

  // Расстановка v1: шапка 45 пикселей поверх, боковая панель 300 слева,
  // остальное — содержимое с отступом 16. В настройках содержимое сужается до
  // 900, как `Container size={900}` там же.
  const inSettings = $derived(page.url.pathname.startsWith('/settings'));
  const inChat = $derived(page.url.pathname.startsWith('/ai'));

  // Разделы настроек. В v1 они живут в той же боковой панели, а не внутри
  // содержимого: панель одна на приложение и меняет состав по разделу.
  // Часть разделов административная. Прятать их от участника — не защита,
  // защита стоит на сервере; но пункт, который отвечает отказом, в меню лишний.
  const isAdmin = $derived(
    data.session?.user.role === 'admin' || data.session?.user.role === 'owner'
  );

  const settingsSections = $derived([
    { href: '/settings/account', label: t('My Profile') },
    { href: '/settings/preferences', label: t('Reading') },
    { href: '/settings/security', label: t('2-step verification') },
    { href: '/settings/api-keys', label: t('API keys') },
    ...(isAdmin ? [{ href: '/settings/sso', label: t('Single sign-on (SSO)') }] : []),
    { href: '/settings/members', label: t('Members') },
    { href: '/settings/groups', label: t('Groups') },
    { href: '/settings/workspace', label: t('Workspace settings') },
    { href: '/settings/ai', label: t('AI') },
    { href: '/settings/sharing', label: t('Public sharing') },
    { href: '/settings/verifications', label: t('Page verification') },
    { href: '/settings/audit', label: t('Audit log') },
    { href: '/settings/license', label: t('License') }
  ]);

  // Разговоры: догруженные и то, что переименовывают прямо сейчас. Правки
  // живут здесь, потому что здесь же живёт список — как в v1.
  let more = $state<Chat[]>([]);
  let cursor = $state<string | null>(null);
  let renaming = $state<string | null>(null);
  let newTitle = $state('');
  let chatFailure = $state<string | null>(null);

  /**
   * Поиск по разговорам.
   *
   * Запрос уходит не на каждую букву: список у разговорчивого человека большой,
   * и обращение на каждый набранный знак нагружает и сервер, и модель отбора.
   */
  let chatQuery = $state('');
  let found = $state<Chat[] | null>(null);

  const chats = $derived(found ?? [...data.chats.items, ...more]);
  const chatGroups = $derived(groupChatsByAge(chats, t));
  const searching = $derived(chatQuery.trim().length > 0);

  $effect(() => {
    const query = chatQuery.trim();
    if (!query) {
      found = null;
      return;
    }

    const timer = setTimeout(async () => {
      try {
        found = await searchChats(query);
      } catch (error) {
        chatFailure = errorText(error, t);
      }
    }, 300);
    return () => clearTimeout(timer);
  });

  /**
   * Значок непрочитанного обновляется от канала событий.
   *
   * Уведомление приходит своим именем и содержимого не несёт: счётчик
   * перечитывается по HTTP, где перечень отбирается доступностью страниц.
   * Без канала значок отставал до следующего перехода по экранам.
   */
  $effect(() => {
    return onRealtime((event) => {
      if (event.operation !== 'notification') return;
      void invalidateAll();
    });
  });

  $effect(() => {
    data.chats;
    more = [];
    cursor = data.chats.nextCursor;
  });

  async function loadMoreChats() {
    if (!cursor) return;
    try {
      const next = await listChats(cursor);
      more = [...more, ...next.items];
      cursor = next.nextCursor;
    } catch (error) {
      chatFailure = errorText(error, t);
    }
  }

  async function renameCurrent(chatId: string) {
    const title = newTitle.trim();
    if (!title) return;
    try {
      await renameChat(chatId, title);
      renaming = null;
      newTitle = '';
      await invalidateAll();
    } catch (error) {
      chatFailure = errorText(error, t);
    }
  }

  async function dropChat(chatId: string) {
    try {
      await deleteChat(chatId);
      if (page.params.chatId === chatId) await goto('/ai');
      else await invalidateAll();
    } catch (error) {
      chatFailure = errorText(error, t);
    }
  }

  async function signOut() {
    await logout();
    await invalidateAll();
    await goto('/login');
  }
</script>

<div data-section="app" class="min-h-screen bg-surface text-text">
  <header
    data-component="AppHeader"
    class="fixed inset-x-0 top-0 z-20 flex h-header items-center justify-between gap-4 border-b border-border bg-surface-muted px-4"
  >
    <a class="text-lg font-semibold" href="/home">
      {data.session?.workspace.name ?? 'Tessera'}
    </a>

    <a
      class="hidden h-8 flex-1 items-center rounded border border-border px-3 text-sm text-text-muted hover:bg-surface-hover sm:flex sm:max-w-md"
      href="/search"
    >
      {t('Search')}
    </a>

    <div class="flex items-center gap-1 text-sm">
      <a
        class="flex items-center gap-1 rounded px-3 py-1.5 font-medium text-text-muted hover:bg-surface-hover"
        href="/notifications"
      >
        {t('Notifications')}
        {#if data.unread > 0}
          <span class="rounded-full bg-accent px-1.5 text-xs text-accent-text">{data.unread}</span>
        {/if}
      </a>
      <button
        class="rounded px-3 py-1.5 font-medium text-text-muted hover:bg-surface-hover"
        onclick={() => theme.toggle()}
      >
        {theme.current === 'dark' ? t('Light mode') : t('Dark mode')}
      </button>
      <button
        class="rounded px-3 py-1.5 font-medium text-text-muted hover:bg-surface-hover"
        onclick={signOut}
      >
        {t('Logout')}
      </button>
    </div>
  </header>

  <aside
    data-component="AppSidebar"
    class="fixed bottom-0 left-0 top-header w-sidebar overflow-y-auto bg-surface-muted p-4"
  >
    {#if inSettings}
      <nav data-component="SettingsNav" class="space-y-0.5">
        <a
          class="flex min-h-[30px] items-center rounded px-2.5 text-sm font-medium text-text-muted hover:bg-surface-hover hover:text-text"
          href="/home"
        >
          {t('Back')}
        </a>
        {#each settingsSections as section (section.href)}
          <a
            class="flex min-h-[30px] items-center rounded px-2.5 text-sm font-medium text-text-muted hover:bg-surface-hover hover:text-text"
            class:bg-surface-active={page.url.pathname === section.href}
            class:text-text={page.url.pathname === section.href}
            href={section.href}
          >
            {section.label}
          </a>
        {/each}
      </nav>
    {:else if inChat}
      <nav data-component="ChatList" class="space-y-0.5">
        <a
          class="mb-2 flex min-h-[30px] items-center justify-center rounded border border-border text-sm font-medium hover:bg-surface-hover"
          href="/ai"
        >
          {t('New chat')}
        </a>

        <input
          class="mb-2 w-full rounded border border-border-input bg-surface px-2.5 py-1 text-sm text-text outline-none focus:border-accent"
          type="search"
          placeholder={t('Search chats')}
          bind:value={chatQuery}
        />

        {#if chatFailure}
          <p class="px-2.5 text-xs text-danger" role="alert">{chatFailure}</p>
        {/if}

        {#each chatGroups as group (group.key)}
          <p class="px-2.5 pb-1 pt-3 text-xs font-medium uppercase tracking-wide text-text-muted">
            {group.label}
          </p>
          {#each group.chats as chat (chat.id)}
            {#if renaming === chat.id}
              <div class="flex items-center gap-1 px-1">
                <input
                  class="min-w-0 flex-1 rounded border border-border-input bg-surface px-2 py-1 text-sm text-text outline-none focus:border-accent"
                  bind:value={newTitle}
                  onkeydown={(event) => {
                    if (event.key === 'Enter') renameCurrent(chat.id);
                    if (event.key === 'Escape') renaming = null;
                  }}
                />
                <button
                  class="rounded px-1.5 py-1 text-xs text-text-muted hover:bg-surface-hover"
                  onclick={() => renameCurrent(chat.id)}
                >
                  {t('Save')}
                </button>
              </div>
            {:else}
              <!--
                Правка и удаление показываются при наведении: две кнопки у каждой
                строки заслоняли название, а название здесь и есть содержимое.
              -->
              <div
                class="group flex min-h-[30px] items-center rounded pr-1 hover:bg-surface-hover"
                class:bg-surface-active={page.params.chatId === chat.id}
              >
                <a
                  class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap px-2.5 text-sm text-text-muted hover:text-text"
                  class:text-text={page.params.chatId === chat.id}
                  href="/ai/{chat.id}"
                >
                  {chat.title ?? t('Untitled chat')}
                </a>
                <span class="shrink-0 px-1 text-[11px] text-text-muted group-hover:hidden">
                  {chatDate(chat.updatedAt, locale.current)}
                </span>
                <span class="hidden shrink-0 items-center group-hover:flex">
                  <button
                    class="rounded px-1.5 py-1 text-xs text-text-muted hover:text-text"
                    onclick={() => {
                      renaming = chat.id;
                      newTitle = chat.title ?? '';
                    }}
                  >
                    {t('Rename')}
                  </button>
                  <Confirm
                    label={t('Delete')}
                    question={t('This action cannot be undone.')}
                    onconfirm={() => dropChat(chat.id)}
                  />
                </span>
              </div>
            {/if}
          {/each}
        {:else}
          <p class="px-2.5 text-sm text-text-muted">{t('No chats found')}</p>
        {/each}

        {#if cursor && !searching}
          <button
            class="flex min-h-[30px] w-full items-center justify-center rounded text-sm text-text-muted hover:bg-surface-hover"
            onclick={loadMoreChats}
          >
            {t('Load more')}
          </button>
        {/if}
      </nav>
    {:else}
      <nav data-component="SpaceList" class="space-y-0.5">
        <a
          class="block px-2.5 pb-1 text-xs font-medium uppercase tracking-wide text-text-muted hover:underline"
          href="/spaces"
        >
          {t('Spaces')}
        </a>
        {#each data.spaces as space (space.id)}
          <a
            class="flex min-h-[30px] items-center rounded px-2.5 text-sm font-medium text-text-muted hover:bg-surface-hover hover:text-text"
            class:bg-surface-active={page.params.spaceSlug === space.slug}
            class:text-text={page.params.spaceSlug === space.slug}
            href="/s/{space.slug}"
          >
            <span class="truncate">{space.name ?? space.slug}</span>
          </a>
          {#if page.params.spaceSlug === space.slug}
            <!-- Дерево показывается только у открытого пространства: остальные
               свернуты, и загружать их ветви незачем. -->
            <PageTree spaceId={space.id} spaceSlug={space.slug} />
            <a
              class="flex min-h-[30px] items-center rounded px-2.5 text-xs text-text-muted hover:bg-surface-hover hover:text-text"
              href="/s/{space.slug}/settings"
            >
              {t('Space settings')}
            </a>
          {/if}
        {:else}
          <p class="px-2.5 text-sm text-text-muted">{t('No spaces found')}</p>
        {/each}
      </nav>
    {/if}

    {#if !inSettings && !inChat}
      <nav class="mt-4 space-y-0.5 border-t border-border pt-4">
        {#each [['/search', t('Search')], ['/favorites', t('Favorites')], ['/templates', t('Templates')], ['/ai', t('AI Chat')], ['/settings/account', t('Settings')]] as [href, title] (href)}
          <a
            class="flex min-h-[30px] items-center rounded px-2.5 text-sm font-medium text-text-muted hover:bg-surface-hover hover:text-text"
            class:bg-surface-active={page.url.pathname.startsWith(href)}
            class:text-text={page.url.pathname.startsWith(href)}
            {href}
          >
            {title}
          </a>
        {/each}
      </nav>
    {/if}

    <p class="mt-4 truncate border-t border-border px-2.5 pt-4 text-xs text-text-muted">
      {data.session?.user.email}
    </p>
  </aside>

  <main class="ml-sidebar min-w-0 pt-header">
    <div class={inSettings ? 'mx-auto max-w-[900px] p-4 pb-20' : 'p-4'}>
      {@render children()}
    </div>
  </main>
</div>
