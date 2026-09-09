<script lang="ts">
  import { goto } from '$app/navigation';
  import Button from '$lib/components/ui/Button.svelte';
  import Field from '$lib/components/ui/Field.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import Panel from '$lib/components/ui/Panel.svelte';
  import Select from '$lib/components/ui/Select.svelte';
  import TextInput from '$lib/components/ui/TextInput.svelte';
  import { errorText } from '$lib/api/failure';
  import {
    listAudit,
    setAuditRetention,
    type AuditRecord
  } from '$lib/features/audit/services/audit';
  import { eventLabel } from '$lib/features/audit/labels';
  import { locale } from '$lib/stores/i18n.svelte';
  import type { PageData } from './$types';
  import type { LayoutData } from '../../$types';

  type Props = { data: PageData & LayoutData };
  const { data }: Props = $props();

  const t = $derived(locale.t);

  let rows = $state<AuditRecord[]>([]);
  let cursor = $state<string | null>(null);
  let busy = $state<string | null>(null);
  let failure = $state<string | null>(null);
  let days = $state('');
  let eventFilter = $state('');
  /** Раскрытая запись. Одна за раз: раскрытые подряд превращают журнал в простыню. */
  let opened = $state<string | null>(null);

  /**
   * Изменённые поля записи.
   *
   * Приходят от сервера полем `changes` и по устройству повторяют v1: объект с
   * перечнем `fields`. Негодное значение — это его отсутствие: журнал пишут
   * разные места, и одна испорченная запись не повод ронять экран.
   */
  function changedFields(row: AuditRecord): string[] {
    const changes = row.changes as { fields?: unknown } | null;
    const fields = changes?.fields;
    return Array.isArray(fields) ? fields.map((one) => String(one)) : [];
  }

  /** Подробности записи парами «поле — значение». */
  function metadataPairs(row: AuditRecord): [string, string][] {
    const metadata = row.metadata;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return [];
    return Object.entries(metadata as Record<string, unknown>).map(([key, value]) => [
      key,
      typeof value === 'object' ? JSON.stringify(value) : String(value)
    ]);
  }

  /** Есть ли что показывать под строкой. Без этого кнопка открывала бы пустоту. */
  function hasDetails(row: AuditRecord): boolean {
    return Boolean(changedFields(row).length || metadataPairs(row).length || row.ipAddress);
  }

  // Первая страница приходит загрузчиком, остальные добираются кнопкой. Поэтому
  // список держится здесь, а не читается из данных напрямую: иначе дозагрузка
  // затиралась бы при каждом обновлении слоя.
  $effect(() => {
    rows = data.page.items;
    cursor = data.page.meta.nextCursor;
  });

  $effect(() => {
    days = String(data.retention?.retentionDays ?? '');
  });

  $effect(() => {
    eventFilter = data.filter.event ?? '';
  });

  const spaceOptions = $derived([
    { value: '', label: t('Filter by space') },
    ...data.spaces.map((one) => ({ value: one.id, label: one.name ?? one.slug }))
  ]);

  async function act(key: string, action: () => Promise<unknown>) {
    busy = key;
    failure = null;
    try {
      await action();
    } catch (error) {
      failure = errorText(error, t);
    } finally {
      busy = null;
    }
  }

  const more = () =>
    act('more', async () => {
      if (!cursor) return;
      const next = await listAudit({ ...data.filter, cursor });
      rows = [...rows, ...next.items];
      cursor = next.meta.nextCursor;
    });

  const applyFilter = (values: { event?: string; spaceId?: string }) => {
    const params = new URLSearchParams();
    const event = values.event ?? data.filter.event;
    const spaceId = values.spaceId ?? data.filter.spaceId;
    if (event) params.set('event', event);
    if (spaceId) params.set('spaceId', spaceId);
    return goto(`/settings/audit${params.size ? `?${params}` : ''}`, { invalidateAll: true });
  };

  const saveRetention = (event: SubmitEvent) => {
    event.preventDefault();
    return act('retention', () => setAuditRetention(Number(days)));
  };

  const when = (value: string | null) =>
    value
      ? new Intl.DateTimeFormat(locale.current, {
          dateStyle: 'medium',
          timeStyle: 'short'
        }).format(new Date(value))
      : '';
</script>

<svelte:head><title>{t('Audit log')} · Tessera</title></svelte:head>

<section data-route="settings-audit">
  <h1 class="mb-6 text-2xl font-semibold">{t('Audit log')}</h1>

  {#if failure}<Notice message={failure} />{/if}

  <div class="mb-6 flex flex-wrap items-end gap-3">
    <form
      class="w-64"
      onsubmit={(event) => {
        event.preventDefault();
        applyFilter({ event: eventFilter });
      }}
    >
      <Field label={t('Filter by event')}>
        <TextInput bind:value={eventFilter} placeholder="page.created" />
      </Field>
      <Button type="submit" variant="quiet">{t('Apply')}</Button>
    </form>
    <div class="w-64">
      <Field label={t('Filter by space')}>
        <Select
          value={data.filter.spaceId ?? ''}
          options={spaceOptions}
          onchange={(value) => applyFilter({ spaceId: value })}
        />
      </Field>
    </div>
    {#if data.filter.event || data.filter.spaceId}
      <div class="mb-4">
        <Button variant="quiet" onclick={() => goto('/settings/audit', { invalidateAll: true })}>
          {t('Reset')}
        </Button>
      </div>
    {/if}
  </div>

  <div class="mb-4 card-soft rounded-md border border-border bg-surface-raised">
    <table data-component="AuditTable" class="w-full text-left text-sm">
      <thead class="border-b border-border text-text-muted">
        <tr>
          <th class="p-3 font-medium">{t('Date')}</th>
          <th class="p-3 font-medium">{t('Actor')}</th>
          <th class="p-3 font-medium">{t('Event')}</th>
          <th class="p-3 font-medium">{t('Resource')}</th>
          <th class="p-3"></th>
        </tr>
      </thead>
      <tbody>
        {#each rows as row (row.id)}
          {@const details = hasDetails(row)}
          <tr class="border-b border-border last:border-0" class:border-0={opened === row.id}>
            <td class="p-3 text-text-muted">{when(row.createdAt)}</td>
            <td class="p-3">
              {row.actor?.name ??
                row.actor?.email ??
                t(row.actorType === 'system' ? 'System' : 'Unknown')}
            </td>
            <td class="p-3">{t(eventLabel(row.event))}</td>
            <td class="p-3 text-text-muted">{row.resourceType ?? ''}</td>
            <td class="p-3 text-right">
              {#if details}
                <!-- Раскрытие, как в v1: изменённые поля и подробности лежат в
                     самой записи, а строкой их не показать. -->
                <button
                  class="rounded px-2 py-1 text-xs text-text-muted hover:bg-surface-hover hover:text-text"
                  type="button"
                  aria-expanded={opened === row.id}
                  onclick={() => (opened = opened === row.id ? null : row.id)}
                >
                  {opened === row.id ? t('Hide') : t('Details')}
                </button>
              {/if}
            </td>
          </tr>
          {#if opened === row.id}
            <tr class="border-b border-border last:border-0">
              <td class="px-3 pb-3" colspan="5">
                <div class="flex flex-wrap gap-8 rounded bg-surface px-3 py-2">
                  {#if changedFields(row).length}
                    <div>
                      <p class="mb-1 text-xs font-semibold">{t('Changed fields')}</p>
                      <div class="flex flex-wrap gap-1.5">
                        {#each changedFields(row) as field (field)}
                          <span class="rounded bg-surface-raised px-1.5 py-0.5 text-xs">
                            {field}
                          </span>
                        {/each}
                      </div>
                    </div>
                  {/if}
                  {#if metadataPairs(row).length}
                    <div>
                      <p class="mb-1 text-xs font-semibold">{t('Metadata')}</p>
                      {#each metadataPairs(row) as [key, value] (key)}
                        <p class="text-xs text-text-muted">
                          <span class="font-medium">{key}</span>: {value}
                        </p>
                      {/each}
                    </div>
                  {/if}
                  {#if row.ipAddress}
                    <div>
                      <p class="mb-1 text-xs font-semibold">{t('IP address')}</p>
                      <p class="font-mono text-xs text-text-muted">{row.ipAddress}</p>
                    </div>
                  {/if}
                </div>
              </td>
            </tr>
          {/if}
        {:else}
          <tr>
            <td class="p-6 text-center text-text-muted" colspan="5">{t('No results found')}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>

  {#if cursor}
    <div class="mb-8">
      <Button variant="quiet" disabled={busy === 'more'} onclick={more}>
        {busy === 'more' ? t('Loading...') : t('Load more')}
      </Button>
    </div>
  {/if}

  {#if data.retention}
    <form onsubmit={saveRetention}>
      <Panel title={t('Audit settings')}>
        <Field label={t('Retention')} hint={t('Days')}>
          <TextInput bind:value={days} />
        </Field>
        <Button type="submit" disabled={busy === 'retention'}>
          {busy === 'retention' ? t('Loading...') : t('Save')}
        </Button>
      </Panel>
    </form>
  {/if}
</section>
