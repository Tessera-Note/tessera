<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import Button from '$lib/components/ui/Button.svelte';
  import Field from '$lib/components/ui/Field.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import Panel from '$lib/components/ui/Panel.svelte';
  import TextInput from '$lib/components/ui/TextInput.svelte';
  import { errorText } from '$lib/api/failure';
  import {
    AI_DRIVERS,
    WEB_SEARCH_DRIVERS,
    resetAiSettings,
    updateAiSettings,
    type AiPatch
  } from '$lib/features/ai/services/settings';
  import { locale } from '$lib/stores/i18n.svelte';
  import type { PageData } from './$types';

  type Props = { data: PageData };
  const { data }: Props = $props();

  const t = $derived(locale.t);

  let driver = $state('');
  let baseUrl = $state('');
  let apiKey = $state('');
  let chatModel = $state('');
  let completionModel = $state('');
  let embeddingDriver = $state('');
  let embeddingBaseUrl = $state('');
  let embeddingApiKey = $state('');
  let embeddingModel = $state('');
  let webSearchDriver = $state('');
  let webSearchBaseUrl = $state('');
  let webSearchApiKey = $state('');

  let busy = $state<string | null>(null);
  let failure = $state<string | null>(null);
  let saved = $state<string | null>(null);

  // Значения приходят с сервера и обновляются после сохранения. Ключи не
  // приходят никогда — только маска, — поэтому поля ключей всегда пусты: пустое
  // поле сервер не трогает, и сохранение имени модели ключ не стирает.
  $effect(() => {
    const found = data.settings;
    driver = found.driver ?? '';
    baseUrl = found.baseUrl ?? '';
    chatModel = found.chatModel ?? '';
    completionModel = found.completionModel ?? '';
    embeddingDriver = found.embeddingDriver ?? '';
    embeddingBaseUrl = found.embeddingBaseUrl ?? '';
    embeddingModel = found.embeddingModel ?? '';
    webSearchDriver = found.webSearchDriver ?? '';
    webSearchBaseUrl = found.webSearchBaseUrl ?? '';
    apiKey = '';
    embeddingApiKey = '';
    webSearchApiKey = '';
  });

  async function save(key: string, values: AiPatch) {
    busy = key;
    failure = null;
    saved = null;
    try {
      const answer = await updateAiSettings(values);
      saved = answer.reindexScheduled
        ? t('Saved. Re-indexing the workspace with the new embedding model.')
        : t('Saved');
      await invalidateAll();
    } catch (error) {
      failure = errorText(error, t);
    } finally {
      busy = null;
    }
  }

  function saveProvider(event: SubmitEvent) {
    event.preventDefault();
    // Отправляется только заполненное: пустой ключ означает «не трогать», и
    // отправить его пустым значило бы стереть сохранённый.
    const values: AiPatch = {
      driver,
      baseUrl,
      chatModel,
      completionModel
    };
    if (apiKey.trim()) values.apiKey = apiKey.trim();
    return save('provider', values);
  }

  function saveEmbedding(event: SubmitEvent) {
    event.preventDefault();
    const values: AiPatch = {
      embeddingDriver,
      embeddingBaseUrl,
      embeddingModel
    };
    if (embeddingApiKey.trim()) values.embeddingApiKey = embeddingApiKey.trim();
    return save('embedding', values);
  }

  function saveSearch(event: SubmitEvent) {
    event.preventDefault();
    const values: AiPatch = { webSearchDriver, webSearchBaseUrl };
    if (webSearchApiKey.trim()) values.webSearchApiKey = webSearchApiKey.trim();
    return save('search', values);
  }

  async function forget() {
    busy = 'reset';
    failure = null;
    saved = null;
    try {
      await resetAiSettings();
      await invalidateAll();
    } catch (error) {
      failure = errorText(error, t);
    } finally {
      busy = null;
    }
  }
</script>

<svelte:head><title>{t('AI')} · Tessera</title></svelte:head>

<section data-route="settings-ai">
  <h1 class="mb-6 text-2xl font-semibold">{t('AI')}</h1>

  {#if failure}<Notice message={failure} />{/if}
  {#if saved}<Notice tone="info" message={saved} />{/if}

  <Panel title={t('Status')}>
    <p class="text-sm text-text-muted">
      {data.settings.resolved.usable ? t('Enabled') : t('Disabled')}
      {#if data.settings.resolved.fromEnvironment}
        · {t('Cleared. AI now follows the server environment again.')}
      {/if}
    </p>
    {#if data.settings.resolved.chatModel}
      <p class="mt-1 text-sm text-text-muted">
        {data.settings.resolved.driver} · {data.settings.resolved.chatModel}
      </p>
    {/if}
  </Panel>

  <form class="mb-8 rounded-lg border border-border bg-surface-raised p-6" onsubmit={saveProvider}>
    <h2 class="mb-4 text-lg font-medium">{t('Provider')}</h2>

    <Field label={t('Provider')}>
      <select class="w-full rounded border border-border bg-surface px-3 py-2" bind:value={driver}>
        <option value="">{t('Select a provider')}</option>
        {#each AI_DRIVERS as one (one)}
          <option value={one}>{one}</option>
        {/each}
      </select>
    </Field>

    <Field label={t('Base URL')}>
      <TextInput bind:value={baseUrl} placeholder="https://openrouter.ai/api/v1" />
    </Field>

    <Field label={t('API key')}>
      <TextInput
        bind:value={apiKey}
        type="password"
        placeholder={data.settings.hasApiKey ? (data.settings.apiKeyPreview ?? '') : ''}
      />
    </Field>

    <Field label={t('Chat model')}>
      <TextInput bind:value={chatModel} placeholder="openai/gpt-5.6-luna" />
    </Field>

    <Field label={t('Completion model')}>
      <TextInput bind:value={completionModel} placeholder="deepseek/deepseek-v4-flash-0731" />
    </Field>

    <Button type="submit" disabled={busy === 'provider'}>
      {busy === 'provider' ? t('Loading...') : t('Save')}
    </Button>
  </form>

  <form class="mb-8 rounded-lg border border-border bg-surface-raised p-6" onsubmit={saveEmbedding}>
    <h2 class="mb-4 text-lg font-medium">{t('Embeddings (semantic search)')}</h2>

    <Field label={t('Provider')}>
      <select
        class="w-full rounded border border-border bg-surface px-3 py-2"
        bind:value={embeddingDriver}
      >
        <option value="">{t('Same as chat provider')}</option>
        {#each AI_DRIVERS as one (one)}
          <option value={one}>{one}</option>
        {/each}
      </select>
    </Field>

    <Field label={t('Base URL')}>
      <TextInput bind:value={embeddingBaseUrl} />
    </Field>

    <Field label={t('API key')}>
      <TextInput
        bind:value={embeddingApiKey}
        type="password"
        placeholder={data.settings.hasEmbeddingApiKey
          ? (data.settings.embeddingApiKeyPreview ?? '')
          : ''}
      />
    </Field>

    <Field label={t('Embedding model')}>
      <TextInput bind:value={embeddingModel} />
    </Field>

    <Button type="submit" disabled={busy === 'embedding'}>
      {busy === 'embedding' ? t('Loading...') : t('Save')}
    </Button>
  </form>

  <form class="mb-8 rounded-lg border border-border bg-surface-raised p-6" onsubmit={saveSearch}>
    <h2 class="mb-4 text-lg font-medium">{t('Web search')}</h2>

    <Field label={t('Provider')}>
      <select
        class="w-full rounded border border-border bg-surface px-3 py-2"
        bind:value={webSearchDriver}
      >
        <option value="">{t('Disabled')}</option>
        {#each WEB_SEARCH_DRIVERS as one (one)}
          <option value={one}>{one}</option>
        {/each}
      </select>
    </Field>

    <Field label={t('Base URL')}>
      <TextInput bind:value={webSearchBaseUrl} placeholder="http://tessera-v2-searxng:8080" />
    </Field>

    <Field label={t('API key')}>
      <TextInput
        bind:value={webSearchApiKey}
        type="password"
        placeholder={data.settings.hasWebSearchApiKey ? '••••' : ''}
      />
    </Field>

    <Button type="submit" disabled={busy === 'search'}>
      {busy === 'search' ? t('Loading...') : t('Save')}
    </Button>
  </form>

  <Panel
    title={t('Clear and use environment')}
    hint={t(
      'AI is currently configured through server environment variables. Picking a provider here overrides them for this workspace.'
    )}
  >
    <Button variant="quiet" disabled={busy === 'reset'} onclick={forget}>
      {t('Clear and use environment')}
    </Button>
  </Panel>
</section>
