<script lang="ts">
  import { IconX } from '@tabler/icons-svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Select from '$lib/components/ui/Select.svelte';
  import Toggle from '$lib/components/ui/Toggle.svelte';
  import { errorText } from '$lib/api/failure';
  import { EXPORT_FORMATS, exportDocx, exportPage } from '$lib/features/page/services/transfer';
  import { locale } from '$lib/stores/i18n.svelte';

  type Props = {
    pageId: string;
    title: string;
    /**
     * Отправить страницу на печать.
     *
     * Печатает браузер на стороне сервера, ответ приходит заданием, и опрос
     * задания живёт в экране страницы — там же, где остальные длинные
     * действия. Здесь только просьба и выключатель подстраниц.
     */
    onpdf: (includeChildren: boolean) => Promise<void>;
    onclose: () => void;
  };
  const { pageId, title, onpdf, onclose }: Props = $props();

  const t = $derived(locale.t);

  let format = $state<string>(EXPORT_FORMATS[0].value);
  let children = $state(false);
  let attachments = $state(false);
  let busy = $state(false);
  let failure = $state<string | null>(null);

  const options = $derived(EXPORT_FORMATS.map((one) => ({ value: one.value, label: one.label })));

  /** Запасное имя файла: сервер называет файл сам, но заголовок может не дойти. */
  const fallback = $derived(`${title || 'page'}.${format === 'html' ? 'html' : 'md'}`);

  async function act(action: () => Promise<unknown>) {
    busy = true;
    failure = null;
    try {
      await action();
      onclose();
    } catch (error) {
      failure = errorText(error, t);
    } finally {
      busy = false;
    }
  }

  const save = () =>
    act(() =>
      exportPage({
        pageId,
        format,
        includeChildren: children,
        includeAttachments: attachments,
        fallbackName: children || attachments ? `${title || 'page'}.zip` : fallback
      })
    );

  const saveDocx = () => act(() => exportDocx(pageId, `${title || 'page'}.docx`));

  const savePdf = () => act(() => onpdf(children));
</script>

<div
  data-component="PageExport"
  class="absolute right-0 top-10 z-40 w-72 rounded-md border border-border bg-surface-raised p-3 shadow-lg"
  role="dialog"
  aria-label={t('Export')}
>
  <div class="mb-2 flex items-center">
    <p class="text-sm font-medium">{t('Export')}</p>
    <button
      class="ml-auto flex h-7 w-7 items-center justify-center rounded text-text-muted hover:bg-surface-hover"
      type="button"
      title={t('Close')}
      aria-label={t('Close')}
      onclick={onclose}
    >
      <IconX size={16} stroke={1.7} />
    </button>
  </div>

  <div class="mb-2">
    <Select bind:value={format} label={t('Format')} {options} />
  </div>

  <!--
    Потомки и вложения переводят выгрузку в архив: одним файлом их не выразить.
    Решает это сервер, здесь только просьба.
  -->
  <Toggle checked={children} label={t('Include subpages')} onchange={(next) => (children = next)} />
  <Toggle
    checked={attachments}
    label={t('Include attachments')}
    onchange={(next) => (attachments = next)}
  />

  <div class="flex flex-wrap gap-2">
    <Button disabled={busy} onclick={save}>{busy ? t('Loading...') : t('Export')}</Button>
    <Button variant="quiet" disabled={busy} onclick={saveDocx}>{t('Word (docx)')}</Button>
    <!-- Печать здесь, а не отдельным значком в полосе: только рядом с
         выключателем «с подстраницами» она умеет печатать ветвь. -->
    <Button variant="quiet" disabled={busy} onclick={savePdf}>{t('PDF')}</Button>
  </div>

  {#if failure}<p class="mt-2 text-sm text-danger" role="alert">{failure}</p>{/if}
</div>
