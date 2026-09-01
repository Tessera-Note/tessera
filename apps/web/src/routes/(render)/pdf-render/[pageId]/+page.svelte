<script lang="ts">
  import PageBody from '$lib/components/page/PageBody.svelte';
  import type { PageData } from './$types';

  type Props = { data: PageData };
  const { data }: Props = $props();
</script>

<svelte:head>
  <title>{data.pages[0]?.title ?? 'Tessera'}</title>
</svelte:head>

<!--
  Признак готовности ставится после того, как разложены все страницы: Gotenberg
  ждёт именно его, и печать раньше даёт пустой или недорисованный документ.
  Атрибут появляется в разметке сразу — сервер отдаёт готовый HTML, и ждать
  здесь нечего, кроме шрифтов и картинок, которые браузер грузит сам.
-->
<div data-pdf-ready="true" data-route="pdf-render" class="mx-auto max-w-3xl p-6 text-black">
  {#each data.pages as one, index (one.pageId)}
    <article class:break-before-page={index > 0}>
      <h1 class="mb-4 text-3xl font-semibold">{one.title ?? ''}</h1>
      <PageBody content={one.content} />
    </article>
  {/each}
</div>

<style>
  /* Каждая следующая страница документа начинается с нового листа. */
  .break-before-page {
    break-before: page;
  }
</style>
