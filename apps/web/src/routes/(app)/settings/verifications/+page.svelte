<script lang="ts">
  import { goto } from '$app/navigation';
  import Button from '$lib/components/ui/Button.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import { errorText } from '$lib/api/failure';
  import { locale } from '$lib/stores/i18n.svelte';
  import {
    VERIFICATION_STATUSES,
    VERIFICATION_TYPES,
    listVerifications,
    type VerificationRow
  } from '$lib/features/verification/services/verifications';
  import type { PageData } from './$types';

  type Props = { data: PageData };
  const { data }: Props = $props();

  const t = $derived(locale.t);

  function label(status: string): string {
    return VERIFICATION_STATUSES.find((one) => one.value === status)?.label ?? status;
  }

  /**
   * Оба отбора живут в адресе и складываются.
   *
   * Складываются — потому что «просроченные в этом пространстве» и есть тот
   * вопрос, ради которого экран открывают; отдельно взятое состояние по всем
   * пространствам отвечает на него только наполовину.
   */
  function choose(key: 'status' | 'spaceId' | 'q' | 'verifierId' | 'type', value: string) {
    const next: Record<string, string> = {
      status: data.status ?? '',
      spaceId: data.spaceId ?? '',
      q: data.query ?? '',
      verifierId: data.verifierId ?? '',
      type: data.type ?? '',
      [key]: value
    };
    const params = new URLSearchParams();
    for (const [name, one] of Object.entries(next)) if (one) params.set(name, one);
    const query = params.toString();
    return goto(query ? `/settings/verifications?${query}` : '/settings/verifications');
  }

  /**
   * Поиск по названию.
   *
   * Уходит не на каждую букву: перечень открывают на вики в тысячу страниц, и
   * обращение на каждый знак нагружает и сервер, и разбор прав по строкам.
   */
  let search = $state('');
  $effect(() => {
    search = data.query ?? '';
  });

  function when(value: string | null): string {
    return value ? new Date(value).toLocaleDateString(locale.current) : '';
  }

  /**
   * Догруженные страницы перечня.
   *
   * Выдача постраничная: отбор по правам выбрасывает строки уже после выборки,
   * поэтому страница бывает короче запрошенной, и конец перечня показывает
   * пустой курсор, а не короткая страница.
   */
  let more = $state<VerificationRow[]>([]);
  let cursor = $state<string | null>(null);
  let busy = $state(false);
  let failure = $state<string | null>(null);
  const rows = $derived([...data.rows, ...more]);

  $effect(() => {
    // Своё состояние сбрасывается вместе с перезагрузкой: догруженное
    // относилось к прежнему отбору.
    void data.rows;
    more = [];
    cursor = data.nextCursor;
  });

  async function loadMore() {
    if (!cursor) return;
    busy = true;
    failure = null;
    try {
      const next = await listVerifications({
        status: data.status,
        spaceId: data.spaceId,
        query: data.query,
        verifierId: data.verifierId,
        cursor
      });
      more = [...more, ...next.items];
      cursor = next.meta.nextCursor;
    } catch (error) {
      failure = errorText(error, t);
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>{t('Page verification')} · Tessera</title></svelte:head>

<section data-route="settings-verifications">
  <h1 class="mb-6 text-2xl font-semibold">{t('Page verification')}</h1>

  <form
    class="mb-4"
    onsubmit={(event) => {
      event.preventDefault();
      choose('q', search.trim());
    }}
  >
    <label class="block">
      <span class="mb-1 block text-sm text-text-muted">{t('Search')}</span>
      <input
        class="h-9 w-full rounded border border-border-input bg-surface px-3 text-sm text-text outline-none focus:border-accent"
        type="search"
        bind:value={search}
        placeholder={t('Search by title')}
      />
    </label>
  </form>

  <div class="mb-4 flex flex-wrap gap-4">
    <label class="min-w-48 flex-1">
      <span class="mb-1 block text-sm text-text-muted">{t('Status')}</span>
      <select
        class="h-9 w-full rounded border border-border-input bg-surface px-3 text-sm text-text outline-none focus:border-accent"
        value={data.status ?? ''}
        onchange={(event) => choose('status', (event.currentTarget as HTMLSelectElement).value)}
      >
        <option value="">{t('No filters applied')}</option>
        {#each VERIFICATION_STATUSES as one (one.value)}
          <option value={one.value}>{t(one.label)}</option>
        {/each}
      </select>
    </label>

    <label class="min-w-48 flex-1">
      <span class="mb-1 block text-sm text-text-muted">{t('Space')}</span>
      <select
        class="h-9 w-full rounded border border-border-input bg-surface px-3 text-sm text-text outline-none focus:border-accent"
        value={data.spaceId ?? ''}
        onchange={(event) => choose('spaceId', (event.currentTarget as HTMLSelectElement).value)}
      >
        <option value="">{t('All spaces')}</option>
        {#each data.spaces as space (space.id)}
          <option value={space.id}>{space.name ?? space.slug}</option>
        {/each}
      </select>
    </label>

    <label class="min-w-48 flex-1">
      <span class="mb-1 block text-sm text-text-muted">{t('Type')}</span>
      <select
        class="h-9 w-full rounded border border-border-input bg-surface px-3 text-sm text-text outline-none focus:border-accent"
        value={data.type ?? ''}
        onchange={(event) => choose('type', (event.currentTarget as HTMLSelectElement).value)}
      >
        <option value="">{t('No filters applied')}</option>
        {#each VERIFICATION_TYPES as one (one.value)}
          <option value={one.value}>{t(one.label)}</option>
        {/each}
      </select>
    </label>

    {#if data.members.length > 0}
      <label class="min-w-48 flex-1">
        <span class="mb-1 block text-sm text-text-muted">{t('Verifiers')}</span>
        <select
          class="h-9 w-full rounded border border-border-input bg-surface px-3 text-sm text-text outline-none focus:border-accent"
          value={data.verifierId ?? ''}
          onchange={(event) =>
            choose('verifierId', (event.currentTarget as HTMLSelectElement).value)}
        >
          <option value="">{t('No filters applied')}</option>
          {#each data.members as person (person.id)}
            <option value={person.id}>{person.name ?? person.email}</option>
          {/each}
        </select>
      </label>
    {/if}
  </div>

  <div class="card-soft rounded-md border border-border bg-surface-raised">
    <table data-component="VerificationTable" class="w-full text-left text-sm">
      <thead class="border-b border-border text-text-muted">
        <tr>
          <th class="p-3 font-medium">{t('Page')}</th>
          <!-- Кто подтверждает. Без столбца строка называет страницу и молчит
               о том, с кого спрашивать. -->
          <th class="p-3 font-medium">{t('Verifiers')}</th>
          <th class="p-3 font-medium">{t('Status')}</th>
          <th class="p-3 font-medium">{t('Expires')}</th>
        </tr>
      </thead>
      <tbody>
        {#each rows as row (row.id)}
          <tr class="border-b border-border last:border-0">
            <td class="p-3">
              <a class="font-medium hover:underline" href="/s/{row.spaceSlug}/p/{row.pageSlugId}">
                {#if row.pageIcon}<span class="mr-1">{row.pageIcon}</span>{/if}
                {row.pageTitle ?? t('Untitled')}
              </a>
              <p class="text-xs text-text-muted">{row.spaceName ?? row.spaceSlug}</p>
            </td>
            <td class="p-3 text-text-muted">
              {#if row.verifiers?.length}
                {row.verifiers.map((one) => one.name || one.email).join(', ')}
              {:else}
                —
              {/if}
            </td>
            <td class="p-3 text-text-muted">{t(label(row.status))}</td>
            <td class="p-3 text-text-muted">{when(row.expiresAt)}</td>
          </tr>
        {:else}
          <tr><td class="p-3 text-text-muted" colspan="4">{t('No pages')}</td></tr>
        {/each}
      </tbody>
    </table>
  </div>

  {#if failure}<div class="mt-4"><Notice message={failure} /></div>{/if}

  {#if cursor}
    <!-- Без продолжения перечень обрывался на потолке выдачи, и молча. -->
    <div class="mt-4">
      <Button variant="quiet" disabled={busy} onclick={loadMore}>
        {busy ? t('Loading...') : t('Load more')}
      </Button>
    </div>
  {/if}
</section>
