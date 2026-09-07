<script lang="ts">
  import { goto } from '$app/navigation';
  import { IconLayoutKanban, IconTable } from '@tabler/icons-svelte';
  import { errorText } from '$lib/api/failure';
  import { convertToBase } from '$lib/features/base/services/bases';
  import { locale } from '$lib/stores/i18n.svelte';

  type Props = {
    pageId: string;
    /** Отказ показывает страница: своего места для него здесь нет. */
    onfailure?: (message: string) => void;
  };
  const { pageId, onfailure }: Props = $props();

  const t = $derived(locale.t);

  let busy = $state<string | null>(null);

  async function convert(template?: 'kanban') {
    busy = template ?? 'base';
    try {
      await convertToBase(pageId, template);
      // Страница становится базой, и её собственный маршрут отправляет туда
      // же. Переход прямой: перечитывание того же адреса дало бы лишний шаг
      // через отказавший редактор.
      await goto(`/base/${pageId}`, { invalidateAll: true });
    } catch (error) {
      onfailure?.(errorText(error, t));
    } finally {
      busy = null;
    }
  }
</script>

<!--
  Подсказка на пустой странице, как в v1 (`empty-page-get-started.tsx`). Это
  единственный способ превратить страницу в базу: списки набирают текстом, а
  таблицу из них потом просят одним нажатием. На странице с текстом подсказка
  не показывается — превращение унесло бы набранное в строки.
-->
<div
  data-component="EmptyStart"
  class="mt-4 flex flex-wrap items-center gap-2 text-sm text-text-muted"
  contenteditable="false"
>
  <span>{t('Get started with')}</span>
  <button
    class="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1 hover:bg-surface-hover disabled:opacity-60"
    type="button"
    disabled={busy !== null}
    onclick={() => convert()}
  >
    <IconTable size={16} stroke={1.7} />
    {t('Base')}
  </button>
  <button
    class="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1 hover:bg-surface-hover disabled:opacity-60"
    type="button"
    disabled={busy !== null}
    onclick={() => convert('kanban')}
  >
    <IconLayoutKanban size={16} stroke={1.7} />
    {t('Kanban')}
  </button>
</div>
