<script lang="ts">
  import { page } from '$app/state';
  import { locale } from '$lib/stores/i18n.svelte';

  const t = $derived(locale.t);

  /**
   * Причина отказа словами человека.
   *
   * Загрузчики отдают код (`error.page.page_not_found`), и словарь переводит
   * его. Кода может не быть вовсе — тогда берётся текст сервера, а его
   * отсутствие закрывает общая фраза: пустая страница с одним числом ничего
   * не объясняет.
   */
  const reason = $derived.by(() => {
    const failure = page.error as { message?: string; code?: string } | null;
    const code = failure?.code;
    if (code) {
      const translated = t(code);
      if (translated !== code) return translated;
    }
    if (page.status === 404)
      return t('This page may have been deleted, moved, or you may not have access.');
    return failure?.message || t('An unexpected error occurred');
  });

  const heading = $derived(page.status === 404 ? t('Page not found') : t('Something went wrong'));
</script>

<svelte:head><title>{heading} · Tessera</title></svelte:head>

<!--
  Своя страница отказа, как в v1 (`pages/error/404`). Без неё SvelteKit
  показывает голый лист с числом и словом на английском: ни оболочки, ни
  объяснения, ни пути назад — а видит её всякий, кто пришёл по устаревшей
  ссылке или потерял право на страницу.
-->
<section
  data-route="error"
  class="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center px-4 text-center"
>
  <p class="mb-2 text-5xl font-semibold text-text-muted">{page.status}</p>
  <h1 class="mb-2 text-xl font-semibold">{heading}</h1>
  <p class="mb-6 text-text-muted">{reason}</p>
  <a
    class="rounded border border-border bg-surface px-4 py-2 font-medium hover:bg-surface-muted"
    href="/home"
  >
    {t('Back to home')}
  </a>
</section>
