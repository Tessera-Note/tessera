<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import Button from '$lib/components/ui/Button.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import Panel from '$lib/components/ui/Panel.svelte';
  import Select from '$lib/components/ui/Select.svelte';
  import Toggle from '$lib/components/ui/Toggle.svelte';
  import { errorText } from '$lib/api/failure';
  import {
    EXPORT_FORMATS,
    IMPORT_ACCEPT,
    IMPORT_SOURCES,
    IMPORT_ZIP_ACCEPT,
    exportSpace,
    importArchive,
    importFile,
    isTable,
    importTaskInfo,
    type FileTask
  } from '$lib/features/page/services/transfer';
  import { locale } from '$lib/stores/i18n.svelte';
  import type { PageData } from './$types';

  type Props = { data: PageData };
  const { data }: Props = $props();

  const t = $derived(locale.t);

  let format = $state<string>(EXPORT_FORMATS[0].value);
  let attachments = $state(false);
  //: Полная выгрузка: обсуждение, метки, проверка и открытые ссылки. Отдельной
  //: галочкой, а не всегда: снимок несёт почту участников обсуждения, и
  //: уносить её вместе с архивом надо осознанно.
  let context = $state(false);
  //: Ввозить таблицу базой, а не страницей с таблицей. Признаком, а не
  //: догадкой: типы столбцов угадываются, и человеку, которому нужен документ,
  //: база досталась бы против его желания.
  let tableAsBase = $state(false);
  let source = $state<string>(IMPORT_SOURCES[0].value);
  let busy = $state<string | null>(null);
  let failure = $state<string | null>(null);
  let done = $state<string | null>(null);

  const formats = $derived(EXPORT_FORMATS.map((one) => ({ value: one.value, label: one.label })));
  const sources = $derived(
    IMPORT_SOURCES.map((one) => ({ value: one.value, label: t(one.label) }))
  );

  let filePicker: HTMLInputElement | undefined = $state();
  let zipPicker: HTMLInputElement | undefined = $state();

  /**
   * Задания, за которыми следим.
   *
   * Ввоз архива идёт в очереди, и его состояние меняется без нашего участия.
   * Опрос ведётся только по тем заданиям, что ещё в работе: законченные
   * опрашивать незачем, а канал событий о заданиях не сообщает.
   */
  let tasks = $state<FileTask[]>([]);
  $effect(() => {
    tasks = data.tasks;
  });

  $effect(() => {
    const pending = tasks.filter((one) => one.status === 'processing');
    if (pending.length === 0) return;

    const timer = setInterval(() => {
      void (async () => {
        for (const one of pending) {
          try {
            const fresh = await importTaskInfo(one.id);
            tasks = tasks.map((task) => (task.id === fresh.id ? fresh : task));
          } catch {
            // Отказ опроса не должен ронять экран: следующий круг повторит.
          }
        }
      })();
    }, 3000);

    return () => clearInterval(timer);
  });

  async function act(key: string, action: () => Promise<unknown>) {
    busy = key;
    failure = null;
    done = null;
    try {
      await action();
    } catch (error) {
      failure = errorText(error, t);
    } finally {
      busy = null;
    }
  }

  const save = () =>
    act('export', () =>
      exportSpace({
        spaceId: data.space.id,
        format,
        includeAttachments: attachments,
        includeContext: context,
        fallbackName: `${data.space.slug}-space-export.zip`
      })
    );

  const bringFile = (event: Event) => {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    return act('file', async () => {
      const page = await importFile({
        file,
        spaceId: data.space.id,
        asBase: tableAsBase && isTable(file.name)
      });
      if (filePicker) filePicker.value = '';
      await goto(`/s/${data.space.slug}/p/${page.slugId}`);
    });
  };

  const bringArchive = (event: Event) => {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    return act('zip', async () => {
      const task = await importArchive({ file, spaceId: data.space.id, source });
      if (zipPicker) zipPicker.value = '';
      tasks = [task, ...tasks];
      done = t('Import in progress');
      await invalidateAll();
    });
  };

  /** Подпись состояния задания. Английские строки — ключи словаря. */
  function statusLabel(status: string): string {
    if (status === 'success') return t('Completed');
    if (status === 'failed') return t('Failed');
    return t('Import in progress');
  }
</script>

<svelte:head><title>{t('Import and export')} · Tessera</title></svelte:head>

<div data-route="space-transfer" class="mx-auto max-w-3xl">
  <h1 class="mb-6 text-2xl font-semibold">{t('Import and export')}</h1>

  {#if failure}<Notice message={failure} />{/if}
  {#if done && !failure}<Notice tone="info" message={done} />{/if}

  <Panel title={t('Export space')}>
    <p class="mb-3 text-sm text-text-muted">
      {t('Export all pages of this space as an archive.')}
    </p>
    <div class="mb-2 max-w-xs">
      <Select bind:value={format} label={t('Format')} options={formats} />
    </div>
    <Toggle
      checked={attachments}
      label={t('Include attachments')}
      onchange={(next) => (attachments = next)}
    />
    <Toggle
      checked={context}
      label={t('Include comments, labels, verification and share links')}
      hint={t('The archive will carry the email addresses of everyone who commented.')}
      onchange={(next) => (context = next)}
    />
    <Button disabled={busy === 'export'} onclick={save}>
      {busy === 'export' ? t('Loading...') : t('Export')}
    </Button>
  </Panel>

  <Panel title={t('Import pages')}>
    <p class="mb-3 text-sm text-text-muted">
      {t('Markdown, HTML, Word, OpenDocument, PDF, CSV and XLSX files become pages of this space.')}
    </p>
    <!-- Выбор до открытия окна файла: после выбора файла ввоз начинается сразу,
         и спрашивать было бы поздно. -->
    <div class="mb-3">
      <Toggle
        checked={tableAsBase}
        label={t('Import a table as a base')}
        hint={t('Column names come from the first row, types are guessed from the values.')}
        onchange={(next) => (tableAsBase = next)}
      />
    </div>
    <!-- Выбор файла спрятан за кнопкой: сам `input type=file` рисуется каждым
         браузером по-своему и не встаёт в расстановку экрана. -->
    <input
      bind:this={filePicker}
      class="hidden"
      type="file"
      accept={IMPORT_ACCEPT}
      onchange={bringFile}
    />
    <Button disabled={busy === 'file'} onclick={() => filePicker?.click()}>
      {busy === 'file' ? t('Loading...') : t('Import file')}
    </Button>
  </Panel>

  <Panel title={t('Import archive')}>
    <p class="mb-3 text-sm text-text-muted">
      {t('An archive is unpacked in the background. Progress is shown below.')}
    </p>
    <div class="mb-2 max-w-xs">
      <Select bind:value={source} label={t('Source')} options={sources} />
    </div>
    <input
      bind:this={zipPicker}
      class="hidden"
      type="file"
      accept={IMPORT_ZIP_ACCEPT}
      onchange={bringArchive}
    />
    <Button disabled={busy === 'zip'} onclick={() => zipPicker?.click()}>
      {busy === 'zip' ? t('Loading...') : t('Import archive')}
    </Button>
  </Panel>

  <Panel title={t('Import tasks')}>
    {#if tasks.length === 0}
      <p class="text-sm text-text-muted">{t('No import tasks yet')}</p>
    {:else}
      <table class="w-full text-left text-sm">
        <thead class="text-text-muted">
          <tr class="border-b border-border">
            <th class="p-2 font-medium">{t('File')}</th>
            <th class="p-2 font-medium">{t('Status')}</th>
            <th class="p-2 font-medium">{t('Created')}</th>
          </tr>
        </thead>
        <tbody>
          {#each tasks as task (task.id)}
            <tr class="border-b border-border">
              <td class="truncate p-2">{task.fileName ?? '—'}</td>
              <td class="p-2">
                {statusLabel(task.status)}
                {#if task.errorMessage}
                  <span class="block text-xs text-danger">{task.errorMessage}</span>
                {/if}
              </td>
              <td class="p-2 text-text-muted">
                {task.createdAt ? new Date(task.createdAt).toLocaleString(locale.current) : '—'}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </Panel>
</div>
