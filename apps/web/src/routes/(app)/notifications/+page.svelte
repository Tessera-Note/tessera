<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import Avatar from '$lib/components/ui/Avatar.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import { errorText } from '$lib/api/failure';
  import { messageKey, splitBold } from '$lib/features/notification/message';
  import {
    markAllRead,
    markRead,
    type Notification,
    type Tab
  } from '$lib/features/notification/services/notifications';
  import { locale } from '$lib/stores/i18n.svelte';
  import type { PageData } from './$types';

  type Props = { data: PageData };
  const { data }: Props = $props();

  const t = $derived(locale.t);

  const tabs: { key: Tab; label: string }[] = $derived([
    { key: 'all', label: t('All notifications') },
    { key: 'direct', label: t('Direct') },
    { key: 'updates', label: t('Updates') }
  ]);

  let busy = $state(false);
  let failure = $state<string | null>(null);

  const text = (one: Notification) => {
    const key = messageKey(one);
    // Незнакомый вид приходит от сервера новее клиента. Показать вид как есть
    // честнее пустой строки: человек хотя бы поймёт, что событие было.
    if (!key) return [one.type, '', ''] as [string, string, string];
    return splitBold(t(key, { name: one.actor?.name ?? t('Unknown') }));
  };

  const linkTo = (one: Notification) =>
    one.page && one.space ? `/s/${one.space.slug}/p/${one.page.slugId}` : null;

  async function act(action: () => Promise<unknown>) {
    busy = true;
    failure = null;
    try {
      await action();
      await invalidateAll();
    } catch (error) {
      failure = errorText(error, t);
    } finally {
      busy = false;
    }
  }

  const when = (value: string) =>
    new Intl.DateTimeFormat(locale.current, { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(value)
    );
</script>

<svelte:head><title>{t('Notifications')} · Tessera</title></svelte:head>

<section data-route="notifications" class="mx-auto max-w-3xl">
  <div class="mb-6 flex items-center justify-between gap-4">
    <h1 class="text-2xl font-semibold">{t('Notifications')}</h1>
    <Button variant="quiet" disabled={busy} onclick={() => act(markAllRead)}>
      {t('Mark all as read')}
    </Button>
  </div>

  <nav data-component="NotificationTabs" class="mb-4 flex gap-1 border-b border-border">
    {#each tabs as tab (tab.key)}
      <a
        class="rounded-t px-3 py-2 text-sm hover:bg-surface-muted"
        class:font-medium={data.tab === tab.key}
        class:border-b-2={data.tab === tab.key}
        class:border-accent={data.tab === tab.key}
        href="/notifications?tab={tab.key}"
        data-sveltekit-noscroll
      >
        {tab.label}
      </a>
    {/each}
  </nav>

  {#if failure}<Notice message={failure} />{/if}

  <ul data-component="NotificationList" class="space-y-2">
    {#each data.notifications as one (one.id)}
      {@const parts = text(one)}
      {@const href = linkTo(one)}
      <li
        class="card-soft rounded-md border border-border bg-surface-raised p-3"
        class:border-accent={!one.readAt}
      >
        <div class="flex items-start justify-between gap-3">
          <!-- Картинка того, кто сделал. Без неё строки извещений
               неразличимы между собой. Так же в v1. -->
          <Avatar src={one.actor?.avatarUrl} name={one.actor?.name} size={28} />
          <div class="min-w-0 flex-1">
            <p class="text-sm">
              {parts[0]}<strong class="font-medium">{parts[1]}</strong>{parts[2]}
            </p>
            {#if one.page}
              <p class="mt-1 truncate text-sm text-text-muted">
                {#if one.page.icon}<span aria-hidden="true">{one.page.icon}</span>{/if}
                {#if href}
                  <a class="hover:underline" {href}>{one.page.title ?? t('Untitled')}</a>
                {:else}
                  {one.page.title ?? t('Untitled')}
                {/if}
              </p>
            {/if}
            <p class="mt-1 text-xs text-text-muted">{when(one.createdAt)}</p>
          </div>

          {#if !one.readAt}
            <Button variant="quiet" disabled={busy} onclick={() => act(() => markRead([one.id]))}>
              {t('Mark as read')}
            </Button>
          {/if}
        </div>
      </li>
    {:else}
      <li
        class="card-soft rounded-md border border-border bg-surface-raised p-6 text-center text-text-muted"
      >
        {t('No notifications')}
      </li>
    {/each}
  </ul>
</section>
