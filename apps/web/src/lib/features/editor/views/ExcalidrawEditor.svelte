<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { errorText } from '$lib/api/failure';
  import Button from '$lib/components/ui/Button.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import { locale } from '$lib/stores/i18n.svelte';

  type Props = {
    /** Разметка полотна: SVG со встроенной сценой. Пустая — новое полотно. */
    svg: string;
    save: (svg: string) => Promise<void>;
    close: () => void;
  };
  const { svg, save, close }: Props = $props();

  const t = $derived(locale.t);

  let host: HTMLDivElement;
  let busy = $state(false);
  let failure = $state<string | null>(null);
  let failed = $state(false);

  /**
   * Полотно Excalidraw существует только библиотекой React, и другой её
   * реализации нет. Поэтому здесь заводится маленький корень React внутри
   * компонента Svelte: переписывать редактор векторной графики ради языка
   * оболочки значило бы получить второй редактор, расходящийся с первым.
   *
   * Библиотека грузится по требованию: она весит мегабайты и нужна только на
   * странице с полотном.
   */
  let root: { unmount: () => void } | null = null;
  /**
   * Ссылка на редактор. Типы библиотеки описывают её собственные виды узлов;
   * компонент их не разбирает, а только передаёт обратно в её же вызовы,
   * поэтому здесь достаточно самого объекта.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let api: any = null;

  onMount(() => {
    let cancelled = false;

    void (async () => {
      try {
        // Откуда библиотека берёт свои шрифты. Без этого она просит их у
        // стороннего CDN, а в закрытом контуре тот не открывается: полотно
        // рисуется, но буквы в нём подменяются запасным начертанием.
        //
        // Ставится до загрузки библиотеки: она читает значение при первом
        // обращении к шрифту, и опоздавшая установка уже ничего не меняет.
        // Каталог кладёт сборка (`apps/web/scripts/copy-excalidraw-assets.mjs`).
        (window as unknown as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH =
          '/excalidraw-assets/';

        const [React, { createRoot }, excalidraw] = await Promise.all([
          import('react'),
          import('react-dom/client'),
          import('@excalidraw/excalidraw')
        ]);
        if (cancelled) return;

        // Сцена восстанавливается из SVG: он сохранён со встроенной сценой, и
        // отдельного файла с разметкой у диаграммы нет.
        let initial: { elements: unknown[]; files: Record<string, unknown> } = {
          elements: [],
          files: {}
        };
        if (svg) {
          try {
            const loaded = (await excalidraw.loadSceneOrLibraryFromBlob(
              new Blob([svg], { type: 'image/svg+xml' }),
              null,
              null
            )) as { data?: { elements?: unknown[]; files?: Record<string, unknown> } };
            initial = {
              elements: loaded?.data?.elements ?? [],
              files: loaded?.data?.files ?? {}
            };
          } catch {
            // Сцена не разобралась: полотно открывается пустым, а прежняя
            // картинка остаётся в документе до сохранения.
            initial = { elements: [], files: {} };
          }
        }

        const created = createRoot(host);
        root = created;
        const options: Record<string, unknown> = {
          initialData: {
            elements: initial.elements,
            files: initial.files,
            appState: { viewBackgroundColor: '#ffffff' }
          },
          excalidrawAPI: (instance: unknown) => {
            api = instance;
          },
          langCode: locale.current.startsWith('ru') ? 'ru-RU' : 'en'
        };
        created.render(React.createElement(excalidraw.Excalidraw as never, options as never));
      } catch (error) {
        failed = true;
        console.error('Полотно не открылось', error);
      }
    })();

    return () => {
      cancelled = true;
    };
  });

  onDestroy(() => root?.unmount());

  async function apply() {
    if (!api) return;
    busy = true;
    try {
      const excalidraw = await import('@excalidraw/excalidraw');
      const image = await (
        excalidraw.exportToSvg as unknown as (options: object) => Promise<SVGElement>
      )({
        elements: api.getSceneElements(),
        appState: { exportEmbedScene: true, exportWithDarkMode: false },
        files: api.getFiles()
      });

      // Шрифты раздаёт приложение: ссылка на сторонний CDN в закрытом контуре
      // не откроется, и картинка приедет без букв.
      const text = new XMLSerializer()
        .serializeToString(image)
        .replace(
          /https:\/\/unpkg\.com\/@excalidraw\/excalidraw@[^/]*\/dist\/prod\//g,
          '/excalidraw-assets/'
        );

      await save(text);
      close();
    } catch (error) {
      // Без этого отказ уходит необработанным обещанием: окно остаётся
      // открытым, но человеку не говорится ничего, и он не знает, сохранилось
      // ли. Работа при этом цела — её можно сохранить второй попыткой.
      failure = errorText(error, t);
    } finally {
      busy = false;
    }
  }
</script>

<div
  data-component="ExcalidrawEditor"
  class="fixed inset-0 z-50 flex flex-col bg-surface"
  role="dialog"
  aria-label={t('Excalidraw (Whiteboard)')}
>
  <div class="flex items-center justify-between border-b border-border px-4 py-2">
    <p class="text-sm font-medium">{t('Excalidraw (Whiteboard)')}</p>
    <div class="flex gap-2">
      <Button disabled={busy || failed} onclick={apply}>{t('Save')}</Button>
      <Button variant="quiet" disabled={busy} onclick={close}>{t('Close')}</Button>
    </div>
  </div>

  {#if failed}
    <p class="p-4 text-sm text-danger" role="alert">{t('Something went wrong')}</p>
  {/if}
  {#if failure}
    <div class="px-4 py-2"><Notice message={failure} /></div>
  {/if}
  <div bind:this={host} class="flex-1"></div>
</div>
