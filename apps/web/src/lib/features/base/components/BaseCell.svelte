<script lang="ts">
  import { asList, cellText, errorKey, shownChoices, type CellContext } from '../cells';
  import { COMPUTED_TYPES, type PropertyType } from '../types';
  import { locale } from '$lib/stores/i18n.svelte';
  import { attachmentUrl, uploadPageFile } from '$lib/features/page/services/attachments';
  import type { BaseProperty } from '../services/bases';

  type Props = {
    property: BaseProperty;
    value: unknown;
    context: CellContext;
    editable: boolean;
    /** Кого можно выбрать в ячейке с человеком. */
    people: { id: string; name: string | null }[];
    /** Страница базы. По ней складываются файлы ячейки и проверяются права. */
    pageId: string;
    onwrite: (value: unknown) => void;
    /** Отказ загрузки файла. Показывает его тот, у кого есть место для сообщения. */
    onfail?: ((error: unknown) => void) | null;
  };
  const {
    property,
    value,
    context,
    editable,
    people,
    pageId,
    onwrite,
    onfail = null
  }: Props = $props();

  const t = $derived(locale.t);
  const type = $derived(property.type as PropertyType);
  /** Вычисляемое значение ставит сервер: поле ввода обещало бы правку, которой нет. */
  const computed = $derived(COMPUTED_TYPES.includes(type));
  const choices = $derived(shownChoices(property.typeOptions));
  const shown = $derived(cellText(value, type, property.typeOptions, context));
  /**
   * Ячейка, которую не удалось посчитать.
   *
   * Показывается переводом по коду, а не тем, что пришло с сервера: там лежит
   * английское пояснение для разработчика, и оно попадало бы человеку с любой
   * из двенадцати локалей.
   */
  const failed = $derived(errorKey(value));

  /** Можно ли выбрать нескольких. Настройка свойства, умолчание — одного. */
  const manyPeople = $derived(
    Boolean((property.typeOptions as { allowMultiple?: boolean } | null)?.allowMultiple)
  );

  /** Со временем или без. Настройка свойства, умолчание — без времени. */
  const withTime = $derived(
    Boolean((property.typeOptions as { includeTime?: boolean } | null)?.includeTime)
  );

  /**
   * Значение для поля ввода даты.
   *
   * Поле со временем принимает `ГГГГ-ММ-ДДTчч:мм`, поле без времени — только
   * дату. Лишние знаки поле молча отбрасывает вместе со значением.
   */
  const dateValue = $derived.by(() => {
    if (typeof value !== 'string') return '';
    return withTime ? value.slice(0, 16).replace(' ', 'T') : value.slice(0, 10);
  });

  /** Прикреплённые файлы. Негодная запись пропускается, а не роняет ячейку. */
  const files = $derived.by(() => {
    if (!Array.isArray(value)) return [] as { id: string; name: string; url: string }[];
    return value
      .filter((one): one is Record<string, unknown> => Boolean(one) && typeof one === 'object')
      .map((one) => ({
        id: String(one.id ?? ''),
        name: String(one.name ?? one.id ?? ''),
        url: String(one.url ?? '')
      }))
      .filter((one) => one.id);
  });

  let uploading = $state(false);

  /**
   * Прикрепить файл к ячейке.
   *
   * Через загрузку вложения страницы: у базы есть своя страница, и её
   * идентификатор задаёт и права, и место хранения. Отказ не гасится молча —
   * иначе выбранный файл просто не появляется, и человек нажимает снова.
   */
  async function attach(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    uploading = true;
    try {
      const saved = await uploadPageFile(file, pageId);
      onwrite([
        ...files,
        { id: saved.id, name: saved.fileName ?? file.name, url: attachmentUrl(saved) }
      ]);
    } catch (error) {
      // Отказ уходит наверх: в самой ячейке места для сообщения нет, а
      // молчащий отказ выглядит как «файл просто не появился», и человек
      // нажимает снова.
      onfail?.(error);
    } finally {
      uploading = false;
      input.value = '';
    }
  }

  /** Пустая строка означает «очистить»: сервер понимает `null`. */
  function write(raw: string) {
    onwrite(raw.trim() === '' ? null : raw);
  }

  function writeNumber(raw: string) {
    if (raw.trim() === '') {
      onwrite(null);
      return;
    }
    const made = Number(raw);
    onwrite(Number.isFinite(made) ? made : null);
  }

  /** Переключить одно значение во множественном выборе. */
  function toggleMany(id: string) {
    const current = asList(value);
    const next = current.includes(id) ? current.filter((one) => one !== id) : [...current, id];
    onwrite(next.length === 0 ? null : next);
  }

  const field =
    'w-full rounded border border-transparent bg-transparent px-2 py-1 hover:border-border focus:border-border disabled:opacity-70';
</script>

{#if (!editable || computed) && type === 'checkbox'}
  <!--
    Отметка и без права правки остаётся отметкой: словами `true` и `false` её
    показывать нельзя — они из кода, а не из языка человека.
  -->
  <input type="checkbox" checked={value === true} disabled aria-label={property.name} />
{:else if failed}
  <!--
    Ошибка счёта. Красится, но не кричит: соседние ячейки строки посчитаны, и
    ошибка одной колонки не должна читаться как поломка всей таблицы.
  -->
  <span class="block px-2 py-1 text-danger" title={t(failed)}>{t(failed)}</span>
{:else if !editable || computed}
  <!--
    Только показ. Вычисляемые свойства сюда попадают всегда: их значение
    ставит сервер при записи строки, и правка отвергается.
  -->
  <span class="block px-2 py-1 text-text-muted">{shown || '—'}</span>
{:else if type === 'checkbox'}
  <input
    type="checkbox"
    checked={value === true}
    aria-label={property.name}
    onchange={(event) => onwrite((event.currentTarget as HTMLInputElement).checked)}
  />
{:else if type === 'select' || type === 'status'}
  <select
    class={field}
    value={typeof value === 'string' ? value : ''}
    aria-label={property.name}
    onchange={(event) => {
      const picked = (event.currentTarget as HTMLSelectElement).value;
      onwrite(picked === '' ? null : picked);
    }}
  >
    <option value="">—</option>
    {#each choices as choice (choice.id)}
      <option value={choice.id}>{choice.name}</option>
    {/each}
  </select>
{:else if type === 'multiSelect'}
  <div class="flex flex-wrap gap-1 px-1 py-1">
    {#each choices as choice (choice.id)}
      {@const picked = asList(value).includes(choice.id)}
      <button
        class="rounded border px-2 py-0.5 text-xs"
        class:border-accent={picked}
        class:text-accent={picked}
        class:border-border={!picked}
        class:text-text-muted={!picked}
        type="button"
        aria-pressed={picked}
        onclick={() => toggleMany(choice.id)}
      >
        {choice.name}
      </button>
    {:else}
      <span class="px-1 text-text-muted">{t('No options yet')}</span>
    {/each}
  </div>
{:else if type === 'person'}
  <!-- Один человек или несколько — по настройке свойства. Список с несколькими
       строками там, где их разрешили: одиночный выбор молча терял бы остальных. -->
  <select
    class={field}
    multiple={manyPeople}
    size={manyPeople ? 3 : undefined}
    value={manyPeople ? asList(value) : typeof value === 'string' ? value : ''}
    aria-label={property.name}
    onchange={(event) => {
      const control = event.currentTarget as HTMLSelectElement;
      if (manyPeople) {
        const picked = Array.from(control.selectedOptions).map((one) => one.value);
        onwrite(picked.length ? picked : null);
        return;
      }
      onwrite(control.value === '' ? null : control.value);
    }}
  >
    {#if !manyPeople}<option value="">—</option>{/if}
    {#each people as one (one.id)}
      <option value={one.id}>{one.name ?? one.id}</option>
    {/each}
  </select>
{:else if type === 'date'}
  <!-- Со временем или без — по настройке свойства: у срока время бессмысленно,
       а у отметки события без него теряется половина сведений. -->
  <input
    class={field}
    type={withTime ? 'datetime-local' : 'date'}
    value={dateValue}
    aria-label={property.name}
    onchange={(event) => write((event.currentTarget as HTMLInputElement).value)}
  />
{:else if type === 'number'}
  <input
    class={field}
    type="number"
    value={value === null || value === undefined ? '' : String(value)}
    aria-label={property.name}
    onchange={(event) => writeNumber((event.currentTarget as HTMLInputElement).value)}
  />
{:else if type === 'file'}
  <!--
    Файлы кладутся тем же путём, что вложения страницы: у базы есть своя
    страница, и её идентификатор задаёт и права, и место хранения. Своего
    хранилища у ячейки нет и заводить его незачем.
  -->
  <div class="flex flex-wrap items-center gap-2">
    {#each files as one (one.id)}
      <span class="flex items-center gap-1 rounded bg-surface-muted px-1.5 py-0.5 text-xs">
        <a class="hover:underline" href={one.url} target="_blank" rel="noopener">{one.name}</a>
        {#if editable}
          <button
            class="text-text-muted hover:text-danger"
            type="button"
            aria-label={t('Remove')}
            onclick={() => onwrite(files.filter((other) => other.id !== one.id))}
          >
            ×
          </button>
        {/if}
      </span>
    {/each}
    {#if editable}
      <label class="cursor-pointer text-xs text-text-muted hover:text-text">
        {uploading ? t('Loading...') : t('Add')}
        <input class="hidden" type="file" onchange={attach} />
      </label>
    {/if}
  </div>
{:else if type === 'longText'}
  <textarea
    class="{field} min-h-16"
    value={typeof value === 'string' ? value : ''}
    aria-label={property.name}
    onchange={(event) => write((event.currentTarget as HTMLTextAreaElement).value)}
  ></textarea>
{:else if type === 'page'}
  <!--
    Ссылка на страницу правится идентификатором: выбора страницы у этого экрана
    нет, а показывается уже развёрнутое название.
  -->
  <input
    class={field}
    value={typeof value === 'string' ? value : ''}
    placeholder={shown}
    aria-label={property.name}
    onchange={(event) => write((event.currentTarget as HTMLInputElement).value)}
  />
{:else}
  <input
    class={field}
    type={type === 'url' ? 'url' : type === 'email' ? 'email' : 'text'}
    value={typeof value === 'string' ? value : shown}
    aria-label={property.name}
    onchange={(event) => write((event.currentTarget as HTMLInputElement).value)}
  />
{/if}
