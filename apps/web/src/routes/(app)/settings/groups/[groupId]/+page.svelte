<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import Button from '$lib/components/ui/Button.svelte';
  import Field from '$lib/components/ui/Field.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import TextInput from '$lib/components/ui/TextInput.svelte';
  import { errorText } from '$lib/api/failure';
  import {
    addGroupMembers,
    deleteGroup,
    removeGroupMember,
    updateGroup
  } from '$lib/features/group/services/groups';
  import { locale } from '$lib/stores/i18n.svelte';
  import type { PageData } from './$types';

  type Props = { data: PageData };
  const { data }: Props = $props();

  const t = $derived(locale.t);

  /** Группу по умолчанию и группу каталога сервер править не даёт. */
  const locked = $derived(data.group.isDefault || Boolean(data.group.directorySource));

  let name = $state('');
  let description = $state('');
  let chosen = $state('');
  let busy = $state<string | null>(null);
  let failure = $state<string | null>(null);

  // Значения формы приходят с сервера и обновляются после сохранения: разовое
  // присваивание оставило бы на экране прежние после чужой правки.
  $effect(() => {
    name = data.group.name;
    description = data.group.description ?? '';
  });

  // Предлагаются только те, кого в группе ещё нет: попытка добавить своего
  // ничего не меняет, но выглядит как действие.
  const candidates = $derived(
    data.people.filter((one) => !data.members.some((member) => member.id === one.id))
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
        <Button
          variant="quiet"
          disabled={busy === 'delete'}
          onclick={() =>
            act('delete', async () => {
              await deleteGroup(data.group.id);
              await goto('/settings/groups');
            })}
        >
          {t('Delete group')}
        </Button>
      {/if}
    </div>
  </form>

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
      {#each data.members as member (member.id)}
        <li
          class="flex items-center justify-between gap-4 border-b border-border pb-2 last:border-0"
        >
          <span class="min-w-0">
            <span class="block truncate text-sm">{member.name ?? member.email}</span>
            <span class="block truncate text-xs text-text-muted">{member.email}</span>
          </span>
          {#if !data.group.isDefault}
            <Button
              variant="quiet"
              disabled={busy === member.id}
              onclick={() => act(member.id, () => removeGroupMember(data.group.id, member.id))}
            >
              {t('Remove')}
            </Button>
          {/if}
        </li>
      {:else}
        <li class="text-sm text-text-muted">{t('No members yet')}</li>
      {/each}
    </ul>
  </div>
</section>
