<script lang="ts">
  import { onMount } from 'svelte';
  import { locale } from '$lib/stores/i18n.svelte';
  import { plainText } from '$lib/features/page/document';

  type Props = {
    /** Документ страницы в том виде, в каком его отдаёт сервер. */
    content: unknown;
  };
  const { content }: Props = $props();

  const t = $derived(locale.t);
  //: Запасной показ: пока редактор не собрался — и если не соберётся вовсе.
  const text = $derived(plainText(content));

  let host: HTMLDivElement;
  let mounted = $state(false);

  onMount(() => {
    let editor: { destroy: () => void; isDestroyed: boolean } | null = null;
    let cancelled = false;

    void (async () => {
      try {
        // Библиотека грузится здесь, а не сверху: она весит сотни килобайт, а
        // страница по ссылке открывается посторонним, часто с телефона. Набор
        // расширений — с ней: обычный импорт затянул бы его в отрисовку на
        // сервере, а там пакет на CommonJS падает с `require is not defined` и
        // роняет страницу целиком.
        const [{ Editor }, { editorExtensions }] = await Promise.all([
          import('@tiptap/core'),
          import('./extensions')
        ]);
        if (cancelled) return;

        const made = new Editor({
          element: host,
          // Правка исключена: это показ, а не редактор. Канала совместной
          // работы здесь тоже нет — у читающего по ссылке нет ни сессии, ни
          // права писать, и подключать его было бы нечем и незачем.
          editable: false,
          extensions: editorExtensions(),
          content: (content ?? null) as never,
          editorProps: {
            attributes: { class: 'tessera-doc', 'data-component': 'DocumentView' }
          }
        });
        editor = made as unknown as { destroy: () => void; isDestroyed: boolean };
        mounted = true;
      } catch (error) {
        // Остаётся запасной показ текстом: пустая страница выглядела бы как
        // потерянное содержимое, а это не так.
        console.error('Показ документа не собрался', error);
      }
    })();

    return () => {
      cancelled = true;
      editor?.destroy();
    };
  });
</script>

<div data-component="DocumentBody">
  <div bind:this={host}></div>
  {#if !mounted}
    <div class="tessera-doc whitespace-pre-wrap">
      {#if text}
        {text}
      {:else}
        <p class="text-text-muted">{t('This page has no content yet')}</p>
      {/if}
    </div>
  {/if}
</div>
