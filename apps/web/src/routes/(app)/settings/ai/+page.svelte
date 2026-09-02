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
    aiModels,
    resetAiSettings,
    testAiConnection,
    updateAiSettings,
    type AiModel,
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

  //: Что ответил провайдер на запрос перечня и на проверку связи. Держится до
  //: следующего действия: человек читает это глазами, а не по секундомеру.
  let models = $state<AiModel[]>([]);
  let embeddingModels = $state<AiModel[]>([]);
  let probe = $state<{ ok: boolean; message: string } | null>(null);

  async function loadModels(kind: 'chat' | 'embedding') {
    busy = `models-${kind}`;
    failure = null;
    try {
      // Введённые прямо сейчас значения уходят вместе с запросом: иначе
      // выбрать модель у нового провайдера нельзя, пока настройки не сохранены.
      const answer = await aiModels(
        kind === 'chat'
          ? { driver, baseUrl, apiKey, kind }
          : { driver: embeddingDriver, baseUrl: embeddingBaseUrl, apiKey: embeddingApiKey, kind }
      );
      if (kind === 'chat') models = answer.models;
      else embeddingModels = answer.models;
    } catch (error) {
      failure = errorText(error, t);
    } finally {
      busy = null;
    }
  }

  async function testConnection() {
    busy = 'test';
    failure = null;
    probe = null;
    try {
      probe = await testAiConnection();
    } catch (error) {
      failure = errorText(error, t);
    } finally {
      busy = null;
    }
  }

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
      saved = t('Cleared. AI now follows the server environment again.');
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
        · {t('Use server environment (default)')}
      {/if}
    </p>
    {#if data.settings.resolved.chatModel}
      <p class="mt-1 text-sm text-text-muted">
        {data.settings.resolved.driver} · {data.settings.resolved.chatModel}
      </p>
    {/if}
  </Panel>

  <form
    class="mb-8 card-soft rounded-md border border-border bg-surface-raised p-5"
    onsubmit={saveProvider}
  >
    <h2 class="mb-4 text-lg font-medium">{t('Provider')}</h2>

    <Field label={t('Provider')}>
      <select
        class="h-9 w-full rounded border border-border-input bg-surface px-3 text-sm text-text outline-none focus:border-accent"
        bind:value={driver}
      >
        <option value="">{t('Use server environment (default)')}</option>
        {#each AI_DRIVERS as one (one.value)}
          <option value={one.value}>{t(one.label)}</option>
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
      <TextInput bind:value={chatModel} placeholder="openai/gpt-5.6-luna" list="ai-chat-models" />
    </Field>

    <Field label={t('Completion model')}>
      <TextInput
        bind:value={completionModel}
        placeholder="deepseek/deepseek-v4-flash-0731"
        list="ai-chat-models"
      />
    </Field>

    <!-- Перечень подсказывается, но не заменяет ввод: у совместимых шлюзов
         каталог бывает неполным, а модель там всё равно работает. -->
    <datalist id="ai-chat-models">
      {#each models as one (one.id)}
        <option value={one.id}>{one.label}</option>
      {/each}
    </datalist>

    <div class="flex flex-wrap gap-2">
      <Button type="submit" disabled={busy === 'provider'}>
        {busy === 'provider' ? t('Loading...') : t('Save')}
      </Button>
      <Button variant="quiet" disabled={busy === 'models-chat'} onclick={() => loadModels('chat')}>
        {busy === 'models-chat' ? t('Loading...') : t('Fetch models from provider')}
      </Button>
      <Button variant="quiet" disabled={busy === 'test'} onclick={testConnection}>
        {busy === 'test' ? t('Loading...') : t('Test connection')}
      </Button>
    </div>

    {#if models.length > 0}
      <p class="mt-2 text-xs text-text-muted">{models.length}</p>
    {/if}

    {#if probe}
      <p class="mt-2 text-sm" class:text-danger={!probe.ok}>{probe.message}</p>
    {/if}
  </form>

  <form
    class="mb-8 card-soft rounded-md border border-border bg-surface-raised p-5"
    onsubmit={saveEmbedding}
  >
    <h2 class="mb-4 text-lg font-medium">{t('Embeddings (semantic search)')}</h2>

    <Field label={t('Provider')}>
      <select
        class="h-9 w-full rounded border border-border-input bg-surface px-3 text-sm text-text outline-none focus:border-accent"
        bind:value={embeddingDriver}
      >
        <option value="">{t('Same as chat provider')}</option>
        {#each AI_DRIVERS as one (one.value)}
          <option value={one.value}>{t(one.label)}</option>
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
      <TextInput bind:value={embeddingModel} list="ai-embedding-models" />
    </Field>

    <datalist id="ai-embedding-models">
      {#each embeddingModels as one (one.id)}
        <option value={one.id}>{one.label}</option>
      {/each}
    </datalist>

    <div class="flex flex-wrap gap-2">
      <Button type="submit" disabled={busy === 'embedding'}>
        {busy === 'embedding' ? t('Loading...') : t('Save')}
      </Button>
      <Button
        variant="quiet"
        disabled={busy === 'models-embedding'}
        onclick={() => loadModels('embedding')}
      >
        {busy === 'models-embedding' ? t('Loading...') : t('Fetch embedding models')}
      </Button>
    </div>
  </form>

  <form
    class="mb-8 card-soft rounded-md border border-border bg-surface-raised p-5"
    onsubmit={saveSearch}
  >
    <h2 class="mb-4 text-lg font-medium">{t('Web search')}</h2>

    <Field label={t('Provider')}>
      <select
        class="h-9 w-full rounded border border-border-input bg-surface px-3 text-sm text-text outline-none focus:border-accent"
        bind:value={webSearchDriver}
      >
        {#each WEB_SEARCH_DRIVERS as one (one.value)}
          <option value={one.value}>{t(one.label)}</option>
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
    hint={data.settings.resolved.fromEnvironment
      ? t(
          'AI is currently configured through server environment variables. Picking a provider here overrides them for this workspace.'
        )
      : undefined}
  >
    <Button variant="quiet" disabled={busy === 'reset'} onclick={forget}>
      {t('Clear and use environment')}
    </Button>
  </Panel>
</section>
