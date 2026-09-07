<script lang="ts">
  import { untrack } from 'svelte';
  import { goto, invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import { IconMenu2, IconPencil, IconStarFilled, IconTrash, IconX } from '@tabler/icons-svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import { onRealtime } from '$lib/features/realtime/socket';
  import PageTree from '$lib/components/page/PageTree.svelte';
  import { imageUrl } from '$lib/features/page/services/images';
  import QuickSearch from '$lib/components/search/QuickSearch.svelte';
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
  import { openSpaceSlug } from '$lib/features/space/open';
  import { favoritesFirst } from '$lib/features/space/ordering';
  import { locale } from '$lib/stores/i18n.svelte';
  import { theme } from '$lib/stores/theme.svelte';
  import type { Snippet } from 'svelte';
  import type { LayoutData } from './$types';

  type Props = { data: LayoutData; children: Snippet };
  const { data, children }: Props = $props();

  const t = $derived(locale.t);

  const workspaceLogo = $derived(imageUrl('workspace-icon', data.session?.workspace.logo));

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

  /**
   * Отмеченные пространства идут в панели первыми.
   *
   * В v1 под них отведён свой раздел панели, потому что остальных пространств
   * там нет вовсе. Здесь панель показывает все, и отдельный раздел повторял бы
   * половину списка; порядок и звезда дают тот же быстрый доступ.
   *
   * Внутри групп порядок сервера сохраняется: сортировка устойчива, и
   * сравнение смотрит только на отметку.
   */
  const favoriteSpaceIds = $derived(new Set(data.favoriteSpaces.map((one) => one.spaceId)));
  const sidebarSpaces = $derived(favoritesFirst(data.spaces, favoriteSpaceIds));

  const openSpace = $derived(openSpaceSlug(page.params, page.data));

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
        chatFailure = null;
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
      // Отказ снимается удавшимся действием. Иначе одна неудача оставляет
      // красную строку в панели навсегда, поверх всего, что вышло потом.
      chatFailure = null;
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
      chatFailure = null;
      await invalidateAll();
    } catch (error) {
      chatFailure = errorText(error, t);
    }
  }

  async function dropChat(chatId: string) {
    try {
      await deleteChat(chatId);
      chatFailure = null;
      if (page.params.chatId === chatId) await goto('/ai');
      else await invalidateAll();
    } catch (error) {
      chatFailure = errorText(error, t);
    }
  }

  /**
   * Быстрый поиск по сочетанию клавиш.
   *
   * В v1 он открывается откуда угодно (`Spotlight`, `mod+K`), и это самый
   * частый способ попасть на страницу. Здесь поиск был отдельным экраном, куда
   * надо сначала перейти.
   */
  let quickOpen = $state(false);

  /**
   * Боковая панель на узком экране.
   *
   * До `lg` она перекрывает содержимое, а не отодвигает его: 300 пикселей из
   * 390 не оставляют места ничему. На широком экране признак не участвует —
   * там панель стоит всегда.
   */
  let sideOpen = $state(false);

  // Переход закрывает панель: иначе выбранная страница остаётся под ней.
  $effect(() => {
    void page.url.pathname;
    untrack(() => (sideOpen = false));
  });

  /**
   * Как это сочетание называется на этой машине.
   *
   * Обработчик принимает и Ctrl, и Cmd, а подсказка называла Ctrl всем: на
   * Mac она указывала не на ту клавишу. Определяется по платформе браузера, а
   * на сервере остаётся Ctrl — там платформы читающего не знают.
   */
  const shortcut = $derived.by(() => {
    if (typeof navigator === 'undefined') return 'Ctrl K';
    return /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent) ? '⌘ K' : 'Ctrl K';
  });

  $effect(() => {
    function onkeydown(event: KeyboardEvent) {
      if (event.key !== 'k' || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      quickOpen = true;
    }
    window.addEventListener('keydown', onkeydown);
    return () => window.removeEventListener('keydown', onkeydown);
  });

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
    <span class="lg:hidden">
      <IconButton
        icon={sideOpen ? IconX : IconMenu2}
        label={t('Sidebar toggle')}
        onclick={() => (sideOpen = !sideOpen)}
      />
    </span>

    <a class="flex items-center gap-2 text-lg font-semibold" href="/home">
      <!--
        Имя продукта, а не название рабочего пространства, — как в v1
        (`components/layouts/global/app-header.tsx`). Название пространства
        здесь читалось как имя приложения: на стенде в углу стояло «Проверка
        v2», и понять по нему, что открыта Tessera, было нельзя.

        Значок рабочего пространства остаётся: в настройках его меняют, и
        показывать его больше негде.
      -->
      {#if workspaceLogo}
        <img class="h-6 w-6 rounded object-cover" src={workspaceLogo} alt="" />
      {/if}
      Tessera
    </a>

    <button
      class="hidden h-8 flex-1 items-center justify-between rounded border border-border px-3 text-sm text-text-muted hover:bg-surface-hover sm:flex sm:max-w-md"
      type="button"
      onclick={() => (quickOpen = true)}
    >
      <span>{t('Search')}</span>
      <!-- Подсказка сочетания: без неё о нём узнают только те, кто его знал. -->
      <kbd class="rounded border border-border px-1 text-xs">{shortcut}</kbd>
    </button>

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
    class="fixed bottom-0 left-0 top-header z-30 w-sidebar overflow-y-auto bg-surface-muted p-4 transition-transform lg:translate-x-0"
    class:-translate-x-full={!sideOpen}
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
                <!--
                  Значками, а не словами: на строку в 300 пикселей вопрос и две
                  кнопки не помещались, и «подтвердить» уезжало за край — то
                  есть удалить разговор было нельзя вовсе. Вопрос при этом
                  остаётся: удаление необратимо.
                -->
                <span class="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                  <button
                    class="flex h-6 w-6 items-center justify-center rounded text-text-muted hover:bg-surface-hover hover:text-text"
                    type="button"
                    title={t('Rename')}
                    aria-label={t('Rename')}
                    onclick={() => {
                      renaming = chat.id;
                      newTitle = chat.title ?? '';
                    }}
                  >
                    <IconPencil size={15} stroke={1.8} />
                  </button>
                  <Confirm
                    label={t('Delete')}
                    question={t('This action cannot be undone.')}
                    icon={IconTrash}
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
        {#each sidebarSpaces as space (space.id)}
          <a
            class="flex min-h-[30px] items-center gap-1.5 rounded px-2.5 text-sm font-medium text-text-muted hover:bg-surface-hover hover:text-text"
            class:bg-surface-active={openSpace === space.slug}
            class:text-text={openSpace === space.slug}
            href="/s/{space.slug}"
          >
            <span class="truncate">{space.name ?? space.slug}</span>
            {#if favoriteSpaceIds.has(space.id)}
              <!-- Звезда объясняет порядок: без неё первые строки выглядят
                   переставленными без причины. Снимают отметку не здесь. -->
              <IconStarFilled class="shrink-0 text-accent" size={12} aria-hidden="true" />
            {/if}
          </a>
          {#if openSpace === space.slug}
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

  <QuickSearch spaces={data.spaces} open={quickOpen} onclose={() => (quickOpen = false)} />

  <!-- Затемнение под открытой панелью: щелчок мимо закрывает её, как и в v1. -->
  {#if sideOpen}
    <button
      class="fixed inset-0 top-header z-20 bg-black/30 lg:hidden"
      type="button"
      aria-label={t('Close')}
      onclick={() => (sideOpen = false)}
    ></button>
  {/if}

  <main class="min-w-0 pt-header lg:ml-sidebar">
    <div class={inSettings ? 'mx-auto max-w-[900px] p-4 pb-20' : 'p-4'}>
      {@render children()}
    </div>
  </main>
</div>
