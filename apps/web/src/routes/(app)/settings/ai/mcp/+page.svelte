<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { IconCheck, IconCopy } from '@tabler/icons-svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import Panel from '$lib/components/ui/Panel.svelte';
  import Toggle from '$lib/components/ui/Toggle.svelte';
  import { errorText } from '$lib/api/failure';
  import { mcpAddress } from '$lib/features/ai/services/mcp';
  import { updateWorkspace } from '$lib/features/workspace/services/settings';
  import { locale } from '$lib/stores/i18n.svelte';
  import type { PageData } from './$types';

  type Props = { data: PageData };
  const { data }: Props = $props();

  const t = $derived(locale.t);

  let busy = $state(false);
  let failure = $state<string | null>(null);
  let copied = $state(false);

  /**
   * Адрес канала.
   *
   * Считается в браузере от адреса самой страницы: канал отвечает по тому же
   * источнику, что и вики, и вписанный руками адрес разошёлся бы с ним при
   * первом же переезде.
   */
  const address = $derived(mcpAddress());

  async function toggle(next: boolean) {
    busy = true;
    failure = null;
    try {
      await updateWorkspace({ mcpEnabled: next });
      // Перечень инструментов приходит от самого канала: включив его, надо
      // перечитать страницу, иначе перечень остаётся пустым.
      await invalidateAll();
    } catch (error) {
      failure = errorText(error, t);
    } finally {
      busy = false;
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
      copied = true;
      setTimeout(() => (copied = false), 2000);
    } catch (error) {
      // Буфер закрыт настройками браузера: адрес остаётся видимым, его можно
      // выделить руками.
      failure = errorText(error, t);
    }
  }
</script>

<svelte:head><title>{t('Model Context Protocol (MCP)')} · Tessera</title></svelte:head>

<div data-route="settings-mcp" class="mx-auto max-w-3xl">
  <nav class="mb-4 text-sm text-text-muted">
    <a class="hover:underline" href="/settings/ai">{t('AI')}</a>
  </nav>

  <h1 class="mb-6 text-2xl font-semibold">{t('Model Context Protocol (MCP)')}</h1>

  {#if failure}<Notice message={failure} />{/if}

  <Panel title={t('Model Context Protocol (MCP)')}>
    <Toggle
      checked={data.settings.mcpEnabled}
      label={t('Enable MCP server')}
      hint={t(
        'Enable the MCP server to allow AI assistants and tools to interact with your workspace content.'
      )}
      disabled={busy}
      onchange={toggle}
    />

    {#if data.settings.mcpEnabled}
      <p class="mb-1 text-sm font-medium">{t('MCP Server URL')}</p>
      <div class="mb-2 flex items-center gap-2">
        <input
          class="h-9 flex-1 rounded border border-border-input bg-surface px-3 text-sm text-text outline-none"
          value={address}
          readonly
          aria-label={t('MCP Server URL')}
        />
        <button
          class="flex h-9 w-9 items-center justify-center rounded border border-border text-text-muted hover:bg-surface-hover"
          type="button"
          title={copied ? t('Copied') : t('Copy')}
          aria-label={copied ? t('Copied') : t('Copy')}
          onclick={copy}
        >
          {#if copied}
            <IconCheck size={16} stroke={1.7} />
          {:else}
            <IconCopy size={16} stroke={1.7} />
          {/if}
        </button>
      </div>
      <p class="text-sm text-text-muted">
        {t(
          'Use your API key for authentication. You can manage API keys in your account settings.'
        )}
      </p>
    {/if}
  </Panel>

  {#if data.settings.mcpEnabled}
    <Panel title={t('Supported tools')}>
      {#if data.tools.length === 0}
        <!--
          Пустой перечень означает, что канал не ответил: сам он всегда
          перечисляет инструменты полностью, независимо от прав.
        -->
        <p class="text-sm text-text-muted">{t('The MCP server did not respond.')}</p>
      {:else}
        <p class="mb-3 text-sm text-text-muted">
          {t('Tools available to connected assistants')}: {data.tools.length}
        </p>
        <ul class="space-y-2 text-sm">
          {#each data.tools as tool (tool.name)}
            <li>
              <code class="font-mono">{tool.name}</code>
              {#if tool.description}
                <span class="block text-xs text-text-muted">{tool.description}</span>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </Panel>
  {/if}
</div>
