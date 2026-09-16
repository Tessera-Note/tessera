<script lang="ts">
  /**
   * Встроенный ролик.
   *
   * Узел рисовался ссылкой: и вставленный адрес, и пункт меню «YouTube» давали
   * строку, по которой надо уходить на сторонний сайт. Здесь он показывается
   * проигрывателем, как в первой версии.
   *
   * Пока адреса нет, показывается поле для него: узел из меню заводится пустым,
   * и без поля заполнить его нечем.
   */
  import { locale } from '$lib/stores/i18n.svelte';
  import { printSheet } from '$lib/stores/print.svelte';
  import { getEmbedUrlAndProvider, sanitizeUrl } from '@tessera/editor-ext';

  type Props = {
    node: { attrs: Record<string, unknown> };
    editor: { isEditable: boolean };
    updateAttributes: (attrs: Record<string, unknown>) => void;
  };
  const { node, editor, updateAttributes }: Props = $props();

  const t = $derived(locale.t);

  const src = $derived(String(node.attrs.src ?? ''));
  const provider = $derived(String(node.attrs.provider ?? ''));
  const width = $derived(Number(node.attrs.width) || 800);
  const height = $derived(Number(node.attrs.height) || 450);

  /** Безопасный адрес проигрывателя. Пустой означает «адреса ещё нет». */
  const player = $derived(src ? sanitizeUrl(src) : '');

  let draft = $state('');

  function apply() {
    const wanted = draft.trim();
    if (!wanted) return;
    // Разбор тот же, что и при вставке: человек может вписать обычный адрес
    // просмотра, а проигрывателю нужен адрес встраивания.
    const found = getEmbedUrlAndProvider(wanted);
    updateAttributes({ src: found.embedUrl, provider: found.provider });
    draft = '';
  }
</script>

<div data-component="EmbedView" class="my-3" data-provider={provider}>
  {#if player && printSheet.active}
    <!--
      Лист печати. Окно чужого сайта в печати не загружается — ни на закрытом
      контуре, ни через список разрешённых адресов Gotenberg, — и на листе
      оставалась пустая рамка в половину страницы. Вместо неё название и адрес
      ссылкой: смотреть по бумаге всё равно нечего, а адрес переносит читателя
      туда, где ролик есть.
    -->
    <p data-component="EmbedPrint" class="text-sm">
      {t('Embedded video')}: <a class="underline" href={player}>{player}</a>
    </p>
  {:else if player}
    <!--
      Права окна ограничены списком: встроенная страница чужая, и давать ей всё
      подряд незачем. Полноэкранный показ оставлен — ради него ролик и
      встраивают.
    -->
    <iframe
      class="w-full rounded-lg border border-border bg-surface-muted"
      style="max-width: {width}px; aspect-ratio: {width} / {height};"
      src={player}
      title={t('Embedded video')}
      loading="lazy"
      referrerpolicy="strict-origin-when-cross-origin"
      sandbox="allow-scripts allow-same-origin allow-popups allow-presentation"
      allow="encrypted-media; picture-in-picture; fullscreen"
      allowfullscreen
    ></iframe>
  {:else if editor.isEditable}
    <div class="rounded-lg border border-dashed border-border p-3">
      <label class="block text-sm text-text-muted" for="embed-url">{t('Embed link')}</label>
      <div class="mt-2 flex gap-2">
        <input
          id="embed-url"
          class="w-full rounded border border-border-input bg-surface px-2 py-1"
          placeholder="https://www.youtube.com/watch?v=..."
          bind:value={draft}
          onkeydown={(event) => event.key === 'Enter' && apply()}
        />
        <button
          type="button"
          class="rounded bg-accent px-3 py-1 text-accent-text hover:bg-accent-hover"
          onclick={apply}
        >
          {t('Add')}
        </button>
      </div>
    </div>
  {:else}
    <p class="text-sm text-text-muted">{t('Embed link')}</p>
  {/if}
</div>
