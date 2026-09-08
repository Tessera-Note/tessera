<script lang="ts">
  import { locale } from '$lib/stores/i18n.svelte';

  type Props = {
    title: string | null;
    editable: boolean;
    /** Сохранить название. Зовётся с задержкой и при потере ввода. */
    onsave: (title: string) => void;
    /** Уйти вводом в текст страницы. Так же в v1: Enter из заголовка. */
    onleave?: () => void;
  };
  const { title, editable, onsave, onleave }: Props = $props();

  const t = $derived(locale.t);

  /**
   * Задержка перед сохранением. Значение из v1
   * (`features/editor/title-editor.tsx`, `useDebouncedCallback(saveTitle, 500)`).
   */
  const DELAY = 500;

  let value = $state('');
  let field: HTMLTextAreaElement | undefined = $state();
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Что уже ушло на сервер. По нему решается, есть ли что сохранять. */
  let saved = '';

  $effect(() => {
    // Название приходит извне: его меняет и сосед по совместной правке, и
    // возврат версии. Своё значение при этом не затирается — пока человек
    // печатает, наверху лежит то же, что он набрал.
    const incoming = title ?? '';
    if (incoming === saved) return;
    saved = incoming;
    value = incoming;
  });

  /**
   * Высота под текст.
   *
   * Название бывает в две строки, и поле в одну строку прятало бы вторую.
   * Считается по содержимому, а не по числу знаков: перенос зависит от ширины.
   */
  function fit() {
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = `${field.scrollHeight}px`;
  }

  $effect(() => {
    value;
    fit();
  });

  function flush() {
    if (timer) clearTimeout(timer);
    timer = null;
    const wanted = value.trim();
    if (wanted === saved.trim()) return;
    saved = wanted;
    onsave(wanted);
  }

  function onInput() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, DELAY);
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    // Перевод строки в названии не нужен, а Enter — привычный способ уйти в
    // текст. Так же в v1.
    event.preventDefault();
    flush();
    onleave?.();
  }

  // Сохранение при уходе со страницы: набранное и не отправленное иначе
  // пропало бы вместе с компонентом.
  $effect(() => () => flush());
</script>

<!--
  Название правится на месте, тем же начертанием, каким показано. Отдельный
  режим «Переименовать» с полем ввода и двумя кнопками расходился с v1 и
  требовал трёх действий там, где хватает щелчка.
-->
{#if editable}
  <textarea
    data-component="PageTitle"
    class="w-full resize-none overflow-hidden border-0 bg-transparent p-0 text-3xl font-semibold leading-tight text-text outline-none placeholder:text-text-muted"
    rows="1"
    aria-label={t('Page title')}
    placeholder={t('Untitled')}
    bind:this={field}
    bind:value
    oninput={onInput}
    onkeydown={onKeydown}
    onblur={flush}
  ></textarea>
{:else}
  <span class="text-3xl font-semibold leading-tight">{title ?? t('Untitled')}</span>
{/if}
