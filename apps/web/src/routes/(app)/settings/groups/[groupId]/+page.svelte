<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import Button from '$lib/components/ui/Button.svelte';
  import Confirm from '$lib/components/ui/Confirm.svelte';
  import Field from '$lib/components/ui/Field.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import TextInput from '$lib/components/ui/TextInput.svelte';
  import { errorText } from '$lib/api/failure';
  import {
    addGroupMembers,
    attachDirectory,
    deleteGroup,
    detachDirectory,
    groupMembers,
    removeGroupMember,
    updateGroup,
    type GroupMember
  } from '$lib/features/group/services/groups';
  import { locale } from '$lib/stores/i18n.svelte';
  import type { PageData } from './$types';

  type Props = { data: PageData };
  const { data }: Props = $props();

  const t = $derived(locale.t);

  /** Группу по умолчанию и группу каталога сервер править не даёт. */
  const locked = $derived(data.group.isDefault || Boolean(data.group.directorySource));

  //: Выбор провайдера и имя группы в каталоге. Пустое имя означает «как
  //: называется здесь»: у большинства развёртываний они совпадают.
  let provider = $state('');
  let directoryKey = $state('');

  function attach(event: SubmitEvent) {
    event.preventDefault();
    if (!provider) return;
    return act('directory', async () => {
      await attachDirectory(data.group.id, provider, directoryKey.trim() || undefined);
      provider = '';
      directoryKey = '';
    });
  }

  let name = $state('');
  let description = $state('');
  let chosen = $state('');
  let busy = $state<string | null>(null);
  let failure = $state<string | null>(null);

  /** Догруженный состав. Конец перечня виден пустым курсором. */
  let more = $state<GroupMember[]>([]);
  let cursor = $state<string | null>(null);
  let loading = $state(false);
  const members = $derived([...data.members, ...more]);

  $effect(() => {
    // Своё состояние сбрасывается вместе с перезагрузкой: добавление и
    // исключение меняют первую страницу состава.
    void data.members;
    more = [];
    cursor = data.membersCursor;
  });

  async function loadMore() {
    if (!cursor) return;
    loading = true;
    failure = null;
    try {
      const next = await groupMembers({ groupId: data.group.id, cursor });
      more = [...more, ...next.items];
      cursor = next.meta.nextCursor;
    } catch (error) {
      failure = errorText(error, t);
    } finally {
      loading = false;
    }
  }

  // Значения формы приходят с сервера и обновляются после сохранения: разовое
  // присваивание оставило бы на экране прежние после чужой правки.
  $effect(() => {
    name = data.group.name;
    description = data.group.description ?? '';
  });

  // Предлагаются только те, кого в группе ещё нет: попытка добавить своего
  // ничего не меняет, но выглядит как действие.
  const candidates = $derived(
    data.people.filter((one) => !members.some((member) => member.id === one.id))
  );

  async function act(key: string, action: () => Promise<unknown>) {
    busy = key;
    failure = null;
    try {
      await action();
      await invalidateAll();
    } catch (error) {
      failure = errorText(error, t);
    } finally {
      busy = null;
    }
  }

  function save(event: SubmitEvent) {
    event.preventDefault();
    return act('save', () =>
      updateGroup(data.group.id, { name: name.trim(), description: description.trim() })
    );
  }

  function add(event: SubmitEvent) {
    event.preventDefault();
    if (!chosen) return;
    return act('add', async () => {
      await addGroupMembers(data.group.id, [chosen]);
      chosen = '';
    });
  }
</script>

<svelte:head><title>{data.group.name} · Tessera</title></svelte:head>

<section data-route="settings-group">
  <a class="text-sm text-text-muted hover:underline" href="/settings/groups">{t('Groups')}</a>
  <h1 class="mb-6 mt-1 text-2xl font-semibold">{data.group.name}</h1>

  {#if failure}<Notice message={failure} />{/if}

  {#if locked}
    <Notice
      tone="info"
      message={data.group.isDefault
        ? t('error.group.you_cannot_update_a_default_group')
        : t('Managed by the directory')}
    />
  {/if}

  <form
    class="mb-8 card-soft rounded-md border border-border bg-surface-raised p-5"
    onsubmit={save}
  >
    <Field label={t('Group name')}>
      <TextInput bind:value={name} disabled={locked} />
    </Field>

    <Field label={t('Description')}>
      <TextInput bind:value={description} disabled={locked} />
    </Field>

    <div class="flex gap-3">
      <Button type="submit" disabled={locked || busy === 'save' || !name.trim()}>
        {busy === 'save' ? t('Loading...') : t('Save')}
      </Button>
      {#if !locked}
        <Confirm
          label={t('Delete group')}
          question={t(
            'Are you sure you want to delete this group? Members will lose access to resources this group has access to.'
          )}
          disabled={busy === 'delete'}
          onconfirm={() =>
            act('delete', async () => {
              await deleteGroup(data.group.id);
              await goto('/settings/groups');
            })}
        />
      {/if}
    </div>
  </form>

  {#if !data.group.isDefault}
    <div class="mb-8 card-soft rounded-md border border-border bg-surface-raised p-5">
      <h2 class="mb-2 text-lg font-medium">{t('Let a directory manage this group')}</h2>

      {#if data.group.directorySource}
        <p class="mb-3 text-sm">{t('Managed by the directory')}</p>
        <Button
          variant="quiet"
          disabled={busy === 'directory'}
          onclick={() =>
            act('directory', async () => {
              await detachDirectory(data.group.id);
            })}
        >
          {t('Detach from directory')}
        </Button>
      {:else if data.providers.length > 0}
        <form class="flex flex-wrap items-end gap-3" onsubmit={attach}>
          <label class="min-w-[12rem] flex-1">
            <span class="mb-1 block text-sm text-text-muted">{t('Provider')}</span>
            <select
              class="h-9 w-full rounded border border-border-input bg-surface px-3 text-sm text-text outline-none focus:border-accent"
              bind:value={provider}
            >
              <option value="">{t('Select a provider')}</option>
              {#each data.providers as one (one.id)}
                <option value={one.id}>{one.name}</option>
              {/each}
            </select>
          </label>
          <label class="min-w-[12rem] flex-1">
            <span class="mb-1 block text-sm text-text-muted">{t('Directory key')}</span>
            <TextInput bind:value={directoryKey} placeholder={data.group.name} />
          </label>
          <Button type="submit" disabled={busy === 'directory' || !provider}>
            {t('Attach to directory')}
          </Button>
        </form>
      {:else}
        <p class="text-sm text-text-muted">{t('No SSO providers found.')}</p>
      {/if}
    </div>
  {/if}

  <div class="card-soft rounded-md border border-border bg-surface-raised p-5">
    <h2 class="mb-4 text-lg font-medium">{t('Members')}</h2>

    {#if !data.group.isDefault}
      <form class="mb-4 flex items-end gap-3" onsubmit={add}>
        <label class="flex-1">
          <span class="mb-1 block text-sm text-text-muted">{t('Add members')}</span>
          <select
            class="h-9 w-full rounded border border-border-input bg-surface px-3 text-sm text-text outline-none focus:border-accent"
            bind:value={chosen}
          >
            <option value="">{t('Select a user')}</option>
            {#each candidates as person (person.id)}
              <option value={person.id}>{person.name ?? person.email}</option>
            {/each}
          </select>
        </label>
        <Button type="submit" disabled={busy === 'add' || !chosen}>{t('Add')}</Button>
      </form>
    {/if}

    <ul data-component="GroupMembers" class="space-y-2">
      {#each members as member (member.id)}
        <li
          class="flex items-center justify-between gap-4 border-b border-border pb-2 last:border-0"
        >
          <span class="min-w-0">
            <span class="block truncate text-sm">{member.name ?? member.email}</span>
            <span class="block truncate text-xs text-text-muted">{member.email}</span>
          </span>
          {#if !data.group.isDefault}
            <!-- Исключённый теряет доступ ко всему, что группа открывала:
                 в v1 это тоже вопрос, а не одно нажатие. -->
            <Confirm
              label={t('Remove')}
              question={t(
                'Are you sure you want to remove this user from the group? The user will lose access to resources this group has access to.'
              )}
              disabled={busy === member.id}
              onconfirm={() => act(member.id, () => removeGroupMember(data.group.id, member.id))}
            />
          {/if}
        </li>
      {:else}
        <li class="text-sm text-text-muted">{t('No members yet')}</li>
      {/each}
    </ul>

    {#if cursor}
      <!-- Без продолжения состав обрывался бы на потолке выдачи, и молча. -->
      <div class="mt-4">
        <Button variant="quiet" disabled={loading} onclick={loadMore}>
          {loading ? t('Loading...') : t('Load more')}
        </Button>
      </div>
    {/if}
  </div>
</section>
