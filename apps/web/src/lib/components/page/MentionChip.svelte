<script lang="ts">
  /**
   * Упоминание человека или страницы.
   *
   * Один показ на два места: узел документа в редакторе и тело комментария.
   * Разделение их означало бы, что имя удалённого убрано со страницы, но
   * осталось в обсуждении под ней, — а это то же самое, ради чего разрешение
   * заводилось.
   */
  import { IconFileDescription } from '@tabler/icons-svelte';
  import { ApiError } from '$lib/api/client';
  import { pageOnce } from '$lib/features/page/services/page-cache';
  import { mentionTarget } from '$lib/features/user/services/mentions';
  import { locale } from '$lib/stores/i18n.svelte';

  type Props = {
    /** Упоминание страницы, а не человека. */
    page: boolean;
    /** Подпись, замороженная при вставке. Остаётся, пока не узнали живую. */
    label: string;
    /** Кого упомянули. Пусто у упоминания страницы. */
    entityId?: string | null;
    /** Короткое имя страницы. Пусто у упоминания человека. */
    slugId?: string | null;
    /** Заголовок внутри страницы, если упомянули его. */
    anchorId?: string | null;
  };
  const { page, label, entityId = null, slugId = null, anchorId = null }: Props = $props();

  const t = $derived(locale.t);

  /**
   * Что известно про упоминаемое.
   *
   * `unknown` это не «нет», а «пока не спросили или спросить не вышло». Разница
   * существенная: сеть не должна превращать упоминание в «удалён», а закрытую
   * страницу — в несуществующую.
   */
  type State =
    | { kind: 'unknown' }
    | { kind: 'gone' }
    | { kind: 'closed' }
    | { kind: 'found'; title: string | null; icon: string | null; deactivated: boolean };

  let state = $state<State>({ kind: 'unknown' });

  /**
   * Разрешение на лету.
   *
   * Подпись заморожена на момент вставки, поэтому без этого имя удалённого
   * оставалось бы в теле каждой страницы, где его упомянули, отключённый
   * выглядел бы как действующий, а ссылка на удалённую страницу — как рабочая.
   */
  $effect(() => {
    // Доводы читаются до ветвления: обращение к ним внутри `if` не подписало бы
    // действие на те, до которых очередь не дошла.
    const isPage = page;
    const who = entityId;
    const key = slugId;

    let dropped = false;

    if (isPage) {
      if (key) {
        void pageOnce(key)
          .then((found) => {
            if (dropped) return;
            state = { kind: 'found', title: found.title, icon: found.icon, deactivated: false };
          })
          .catch((error: unknown) => {
            if (dropped) return;
            // Сервер эти случаи различает, и различие видно человеку: удалённая
            // страница перечёркнута, закрытая правами остаётся кликабельной —
            // по ней можно попросить доступ. Всё прочее, включая потерянный
            // вход на публичном показе, оставляет прежнюю подпись.
            const status = error instanceof ApiError ? error.status : 0;
            if (status === 404) state = { kind: 'gone' };
            else if (status === 403) state = { kind: 'closed' };
          });
      }
    } else if (who) {
      void mentionTarget(who)
        .then((found) => {
          if (dropped) return;
          state = found
            ? { kind: 'found', title: found.name, icon: null, deactivated: found.deactivated }
            : { kind: 'gone' };
        })
        .catch(() => {
          // Прежняя подпись остаётся: отказ ничего не говорит о человеке.
        });
    }

    return () => {
      dropped = true;
    };
  });

  /** Подпись показа: живая, когда её узнали, и прежняя, пока нет. */
  const shown = $derived(state.kind === 'found' && state.title ? state.title : label);

  const userGone = $derived(!page && state.kind === 'gone');
  const userDim = $derived(userGone || (state.kind === 'found' && state.deactivated));
  const userTitle = $derived(
    userGone
      ? t('This account no longer exists.')
      : state.kind === 'found' && state.deactivated
        ? t('This account is deactivated.')
        : undefined
  );

  const pageGone = $derived(page && state.kind === 'gone');
  const pageClosed = $derived(page && state.kind === 'closed');
  const icon = $derived(state.kind === 'found' ? state.icon : null);
  const href = $derived(`/p/${slugId}${anchorId ? `#${anchorId}` : ''}`);
</script>

<!--
  Упоминание страницы это ссылка, упоминание человека — нет: у человека внутри
  вики своего экрана нет, и ссылка вела бы в никуда.
-->
{#if page && slugId && !pageGone}
  <a
    data-component="MentionChip"
    class="rounded bg-accent-soft px-1 py-0.5 text-sm no-underline {pageClosed
      ? 'text-muted'
      : 'text-accent'}"
    {href}
    title={pageClosed ? t("You don't have access to this page.") : undefined}
  >
    {#if icon}<span class="mr-0.5">{icon}</span>{:else}<IconFileDescription
        size={14}
        class="mb-0.5 inline"
      />{/if}{shown}
  </a>
{:else if page && pageGone}
  <!-- Вести некуда: узел остаётся в содержимом и правке не мешает, но виден
       как недоступный, а не как рабочая ссылка с прежним заголовком. -->
  <span
    data-component="MentionChip"
    class="rounded bg-surface-muted px-1 py-0.5 text-sm text-muted line-through"
    title={t('This page no longer exists. It may have been deleted.')}
  >
    <IconFileDescription size={14} class="mb-0.5 inline" />{shown}
  </span>
{:else}
  <span
    data-component="MentionChip"
    class="rounded bg-accent-soft px-1 py-0.5 text-sm {userDim ? 'text-muted' : 'text-accent'}"
    title={userTitle}
  >
    @{userGone ? t('Deleted user') : shown}
  </span>
{/if}
