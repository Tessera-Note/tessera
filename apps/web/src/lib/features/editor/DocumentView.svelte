<script lang="ts">
  import { locale } from '$lib/stores/i18n.svelte';
  import { plainText } from '$lib/features/page/document';

  type Props = {
    /** Документ страницы в том виде, в каком его отдаёт сервер. */
    content: unknown;
    /**
     * Показ закончен: документ нарисован либо не соберётся вовсе.
     *
     * Нужен печати. Она снимает лист по признаку в разметке, а разметку здесь
     * собирает редактор уже в браузере: без сигнала лист снимался бы с
     * запасного плоского текста.
     */
    onready?: () => void;
  };
  const { content, onready }: Props = $props();

  const t = $derived(locale.t);
  //: Запасной показ: пока редактор не собрался — и если не соберётся вовсе.
  const text = $derived(plainText(content));

  let host: HTMLDivElement;
  let mounted = $state(false);

  /**
   * Показ пересобирается при смене документа.
   *
   * Эффект, а не `onMount`: одна и та же разметка показывает разные документы
   * — соседние страницы по публичной ссылке, второй открытый предпросмотр
   * шаблона, — и экземпляр компонента при этом остаётся прежним. Собранный
   * однажды показ оставлял на экране предыдущий документ.
   */
  $effect(() => {
    const shown = content;
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
          content: (shown ?? null) as never,
          editorProps: {
            attributes: { class: 'tessera-doc', 'data-component': 'DocumentView' }
          }
        });
        editor = made as unknown as { destroy: () => void; isDestroyed: boolean };
        mounted = true;
        onready?.();
      } catch (error) {
        // Остаётся запасной показ текстом: пустая страница выглядела бы как
        // потерянное содержимое, а это не так.
        console.error('Показ документа не собрался', error);
        // Печати всё равно сообщается: лучше лист с плоским текстом, чем
        // ожидание до истечения срока и отказ без единой страницы.
        onready?.();
      }
    })();

    return () => {
      cancelled = true;
      editor?.destroy();
      editor = null;
      // Показ строится заново, и до его готовности снова стоит запасной текст:
      // иначе на месте нового документа висел бы старый.
      mounted = false;
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
