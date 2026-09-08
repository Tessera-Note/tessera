<script lang="ts">
  import PageBody from '$lib/components/page/PageBody.svelte';
  import { headings } from '$lib/features/page/document';
  import { locale } from '$lib/stores/i18n.svelte';
  import type { PageData } from './$types';

  type Props = { data: PageData };
  const { data }: Props = $props();

  const t = $derived(locale.t);

  /**
   * Состав документа.
   *
   * Собирается из самих документов, а не из показанной разметки: разметку
   * рисует редактор отдельной загрузкой, и к первому же снимку листа её может
   * ещё не быть.
   */
  const contents = $derived(
    data.pages.map((one) => ({
      title: one.title ?? '',
      chapters: headings(one.content)
    }))
  );

  /**
   * Показывать ли оглавление.
   *
   * Один заголовок оглавлением не бывает, а лист с одной строкой в начале
   * документа только сбивает. Ветвь из нескольких страниц перечисляется всегда:
   * там состав — это сами страницы.
   */
  const withContents = $derived(
    data.pages.length > 1 || contents.reduce((count, one) => count + one.chapters.length, 0) > 1
  );

  /**
   * Сколько страниц уже нарисовано.
   *
   * Признак готовности ставится по этому счёту, а не сразу. Печать снимает
   * лист по признаку, а показ документа собирает редактор уже в браузере,
   * отдельной загрузкой: до неё на месте страницы стоит запасной плоский
   * текст, и лист, снятый в этот миг, уходил без картинок, таблиц и диаграмм.
   */
  let painted = $state(0);

  /**
   * Терпение кончилось.
   *
   * Без предела одна незагрузившаяся страница держала бы печать до истечения
   * срока, и заказчик получил бы отказ вместо документа. Лучше лист с плоским
   * текстом: там хотя бы есть что читать.
   */
  let impatient = $state(false);

  $effect(() => {
    const timer = setTimeout(() => (impatient = true), 15000);
    return () => clearTimeout(timer);
  });

  const ready = $derived(data.pages.length === 0 || painted >= data.pages.length || impatient);
</script>

<svelte:head>
  <title>{data.pages[0]?.title ?? 'Tessera'}</title>
</svelte:head>

<!--
  Признак готовности ставится после того, как разложены все страницы: Gotenberg
  ждёт именно его, и печать раньше даёт пустой или недорисованный документ.
-->
<div
  data-pdf-ready={ready ? 'true' : undefined}
  data-route="pdf-render"
  class="mx-auto max-w-3xl p-6 text-black"
>
  {#if withContents}
    <!-- Отдельным листом: оглавление, приклеенное к первой странице, читается
         как её часть. -->
    <section data-component="PrintToc" class="break-after-page">
      <h1 class="mb-4 text-2xl font-semibold">{t('Table of contents')}</h1>
      <ul class="space-y-1 text-sm">
        {#each contents as one, index (index)}
          {#if data.pages.length > 1}
            <li class="font-medium">{one.title || t('Untitled')}</li>
          {/if}
          {#each one.chapters as chapter, level (level)}
            <li
              style:padding-left="{(Math.min(chapter.level, 4) - (data.pages.length > 1 ? 0 : 1)) *
                12}px"
            >
              {chapter.text}
            </li>
          {/each}
        {/each}
      </ul>
    </section>
  {/if}

  {#each data.pages as one, index (one.pageId)}
    <article class:break-before-page={index > 0 || withContents}>
      <h1 class="mb-4 text-3xl font-semibold">{one.title ?? ''}</h1>
      <PageBody content={one.content} onready={() => (painted += 1)} />
    </article>
  {/each}
</div>

<style>
  /* Каждая следующая страница документа начинается с нового листа. */
  .break-before-page {
    break-before: page;
  }

  /* Оглавление занимает свой лист целиком. */
  .break-after-page {
    break-after: page;
  }
</style>
