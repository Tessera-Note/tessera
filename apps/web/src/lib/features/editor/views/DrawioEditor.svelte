<script lang="ts">
  import { env } from '$env/dynamic/public';
  import { errorText } from '$lib/api/failure';
  import Button from '$lib/components/ui/Button.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import { locale } from '$lib/stores/i18n.svelte';

  type Props = {
    /** Разметка диаграммы. Пустая строка означает новую. */
    xml: string;
    /** Сохранить: сюда приходит SVG со встроенной разметкой. */
    save: (svg: string) => Promise<void>;
    close: () => void;
  };
  const { xml, save, close }: Props = $props();

  const t = $derived(locale.t);

  /**
   * Адрес редактора диаграмм.
   *
   * Свой сервис рядом в развёртывании, а не `diagrams.net` в интернете:
   * экземпляр работает без обращений наружу. За обратным прокси он открыт по
   * пути `/drawio/`, и это же значение стоит умолчанием.
   *
   * Окружение динамическое: статическое печётся в образ, и заданный при
   * запуске адрес молча не применялся бы.
   */
  const base = env.PUBLIC_DRAWIO_URL || '/drawio/';

  const address = $derived(
    `${base.replace(/\/+$/, '')}/?embed=1&proto=json&spin=1&libraries=1&saveAndExit=1&noSaveBtn=1&ui=kennedy`
  );

  let frame: HTMLIFrameElement;
  let busy = $state(false);
  let failure = $state<string | null>(null);

  /**
   * Обмен сообщениями с редактором.
   *
   * Протокол его собственный: он присылает `init`, мы отвечаем `load`; по
   * нажатию «сохранить» он присылает `save`, и мы просим `export` — сохранять
   * надо картинку со встроенной разметкой, а не саму разметку, иначе диаграмму
   * нечем показать в документе.
   */
  function onMessage(event: MessageEvent) {
    if (!frame || event.source !== frame.contentWindow) return;

    let message: { event?: string; data?: string; xml?: string };
    try {
      message = JSON.parse(String(event.data));
    } catch {
      // Редактор шлёт и не-JSON: они не наши.
      return;
    }

    if (message.event === 'init') {
      frame.contentWindow?.postMessage(JSON.stringify({ action: 'load', xml, autosave: 1 }), '*');
      return;
    }

    if (message.event === 'save') {
      frame.contentWindow?.postMessage(JSON.stringify({ action: 'export', format: 'xmlsvg' }), '*');
      return;
    }

    if (message.event === 'export' && message.data) {
      void keep(message.data);
      return;
    }

    if (message.event === 'exit') {
      close();
    }
  }

  /**
   * Сохранить и закрыть — но только если сохранилось.
   *
   * Закрытие в `finally` означало, что при отказе загрузки окно закрывается
   * так же, как при успехе: правка диаграммы теряется молча, и человеку об
   * этом не говорится ничего. Отказ показывается, окно остаётся открытым, и
   * работу можно сохранить второй попыткой.
   */
  async function keep(svg: string): Promise<void> {
    busy = true;
    failure = null;
    try {
      await save(svg);
      close();
    } catch (error) {
      failure = errorText(error, t);
    } finally {
      busy = false;
    }
  }

  $effect(() => {
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  });
</script>

<div
  data-component="DrawioEditor"
  class="fixed inset-0 z-50 flex flex-col bg-surface"
  role="dialog"
  aria-label={t('Diagram editor')}
>
  <div class="flex items-center justify-between border-b border-border px-4 py-2">
    <p class="text-sm font-medium">{t('Diagram editor')}</p>
    <Button variant="quiet" disabled={busy} onclick={close}>{t('Close')}</Button>
  </div>
  {#if failure}
    <div class="px-4 py-2"><Notice message={failure} /></div>
  {/if}
  <iframe bind:this={frame} class="flex-1" src={address} title={t('Diagram editor')}></iframe>
</div>
