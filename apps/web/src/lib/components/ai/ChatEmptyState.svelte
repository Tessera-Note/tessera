<script lang="ts">
  import { locale } from '$lib/stores/i18n.svelte';

  type Props = {
    /** Подставить начало запроса в поле ввода. */
    onpick: (prompt: string) => void;
  };
  const { onpick }: Props = $props();

  const t = $derived(locale.t);

  /**
   * С чего начать разговор.
   *
   * Состав тот же, что в v1 (`ee/ai-chat/components/chat-empty-state.tsx`).
   * Отличие одно: v1 отправлял начало фразы сразу, и модель получала
   * «Найди страницы про » без предмета. Здесь начало попадает в поле ввода,
   * а отправляет человек.
   */
  const suggestions = $derived([
    { label: t('Search across all pages'), prompt: t('Search for pages about ') },
    { label: t('Create a new page'), prompt: t('Create a new page titled ') },
    { label: t('Summarize a page'), prompt: t('Summarize the page ') },
    { label: t('Update page content'), prompt: t('Update the page ') }
  ]);
</script>

<div data-component="ChatEmptyState" class="flex flex-col items-center py-10 text-center">
  <p class="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-text-muted">
    {t('Tessera AI')}
  </p>
  <h1 class="mb-8 text-2xl font-semibold">{t('What can I help you with?')}</h1>

  <div class="w-full max-w-[600px] text-left">
    <h2 class="mb-2 text-xs font-medium uppercase tracking-wide text-text-muted">
      {t('Get started')}
    </h2>
    <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {#each suggestions as one (one.label)}
        <button
          type="button"
          class="rounded-md border border-border px-4 py-2.5 text-left text-sm text-text-muted transition-colors hover:border-border-input hover:bg-surface-hover hover:text-text"
          onclick={() => onpick(one.prompt)}
        >
          {one.label}
        </button>
      {/each}
    </div>
  </div>
</div>
