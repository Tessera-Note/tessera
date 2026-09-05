<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import Button from '$lib/components/ui/Button.svelte';
  import Field from '$lib/components/ui/Field.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import Panel from '$lib/components/ui/Panel.svelte';
  import TextInput from '$lib/components/ui/TextInput.svelte';
  import { errorText } from '$lib/api/failure';
  import { createSpace } from '$lib/features/space/services/spaces';
  import { locale } from '$lib/stores/i18n.svelte';
  import type { PageData } from './$types';

  type Props = { data: PageData };
  const { data }: Props = $props();

  const t = $derived(locale.t);
  // Пространства заводит администратор рабочего пространства, и сервер это
  // проверяет. Форма прячется от остальных, чтобы не предлагать заведомый отказ.
  const admin = $derived(
    data.session?.user.role === 'admin' || data.session?.user.role === 'owner'
  );

  /**
   * Три перечня главной: что правили, избранное, своё.
   *
   * Приведены к одному виду строки, потому что показываются они одинаково, а
   * приходят по-разному: у избранного нет ни даты, ни идентификатора
   * пространства, зато есть короткое имя — этого для ссылки достаточно.
   */
  type Row = {
    id: string;
    slugId: string;
    title: string | null;
    icon: string | null;
    spaceSlug: string;
    spaceName: string | null;
    when: string | null;
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
      return data.favorites.map((one) => ({
        id: one.id,
        slugId: one.slugId,
        title: one.title,
        icon: one.icon,
        spaceSlug: one.spaceSlug,
        spaceName: one.spaceName,
        when: null
      }));
    }
    const source = tab === 'mine' ? data.mine : data.recent;
    return source.map((one) => ({
      id: one.id,
      slugId: one.slugId,
      title: one.title,
      icon: one.icon,
      spaceSlug: one.spaceSlug,
      spaceName: one.spaceName,
      when: shortDate(tab === 'mine' ? one.createdAt : one.updatedAt)
    }));
  });

  const empty = $derived(
    tab === 'favorites' ? t('No favorites yet') : t('No pages match your search.')
  );

  /**
   * Обращение к помощнику прямо с главной.
   *
   * Разговор заводится на своём экране: сюда он не помещается, а вести его в
   * двух местах значило бы держать два одинаковых потока. Вопрос уходит
   * адресом, и экран разговора отправляет его сам.
   */
  let question = $state('');

  async function askAssistant(event: SubmitEvent) {
    event.preventDefault();
    const text = question.trim();
    if (!text) return;
    question = '';
    await goto(`/ai?ask=${encodeURIComponent(text)}`);
  }

  let creating = $state(false);
  let name = $state('');
  let busy = $state(false);
  let failure = $state<string | null>(null);

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!name.trim()) return;

    busy = true;
    failure = null;
    return (async () => {
      try {
        const space = await createSpace({ name: name.trim() });
        name = '';
        creating = false;
        await invalidateAll();
        await goto(`/s/${space.slug}`);
      } catch (error) {
        failure = errorText(error, t);
      } finally {
        busy = false;
      }
    })();
  }
</script>

<svelte:head><title>{t('Home')} · Tessera</title></svelte:head>

<section data-route="home">
  <div class="mb-6 flex items-center justify-between gap-4">
    <h1 class="text-2xl font-semibold">{t('Home')}</h1>
    {#if admin && !creating}
      <Button onclick={() => (creating = true)}>{t('Create space')}</Button>
    {/if}
  </div>

  <!--
    Поле обращения к помощнику, как в v1
    (`features/home/components/home-ai-prompt.tsx`). Показывается, только если
    помощник включён: предлагать то, что ответит отказом, хуже, чем не
    предлагать вовсе.
  -->
  {#if data.session?.workspace.aiChatEnabled}
    <div data-component="HomeAiPrompt" class="mb-8 text-center">
      <h2 class="mb-1 text-xl font-semibold">
        {t('Welcome to {{name}}', { name: data.session?.workspace.name ?? 'Tessera' })}
      </h2>
      <p class="mb-4 text-sm text-text-muted">{t('Ask anything or search your workspace')}</p>

      <form class="mx-auto flex max-w-2xl gap-2" onsubmit={askAssistant}>
        <div class="flex-1">
          <TextInput bind:value={question} placeholder={t('Ask anything...')} />
        </div>
        <Button type="submit" disabled={!question.trim()}>{t('Send')}</Button>
      </form>
    </div>
  {/if}

  {#if failure}<Notice message={failure} />{/if}

  {#if creating}
    <form onsubmit={submit}>
      <Panel title={t('Create space')}>
        <Field label={t('Space name')} hint={t('Space slug')}>
          <TextInput bind:value={name} placeholder={t('e.g Sales')} required />
        </Field>
        <div class="flex gap-2">
          <Button type="submit" disabled={busy}>{busy ? t('Loading...') : t('Create')}</Button>
          <Button variant="quiet" onclick={() => (creating = false)}>{t('Cancel')}</Button>
        </div>
      </Panel>
    </form>
  {/if}

  <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
    {#each data.spaces as space (space.id)}
      <a
        data-component="SpaceCard"
        class="card-soft rounded-md border border-border bg-surface-raised p-5 hover:border-text-muted"
        href="/s/{space.slug}"
      >
        <p class="font-medium">{space.name ?? space.slug}</p>
        {#if space.description}
          <p class="mt-1 line-clamp-2 text-sm text-text-muted">{space.description}</p>
        {/if}
      </a>
    {:else}
      <p class="text-text-muted">{t('No spaces found')}</p>
    {/each}
  </div>

  <!--
    Три перечня, как в v1 (`features/home/components/home-tabs.tsx`). Без них
    главная показывала только карточки пространств: узнать, что в вики
    происходило, было негде, а маршруты «последние» и «созданные мной» на
    сервере есть и не звались ниоткуда.
  -->
  <div data-component="HomeTabs" class="mt-10">
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
              <span aria-hidden="true">{row.icon ?? '📄'}</span>
              {row.title ?? t('Untitled')}
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
</section>
