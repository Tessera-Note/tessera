<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import Button from '$lib/components/ui/Button.svelte';
  import PageListTabs from '$lib/components/page/PageListTabs.svelte';
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

  <div class="mt-10">
    <PageListTabs recent={data.recent} favorites={data.favorites} mine={data.mine} />
  </div>
</section>
