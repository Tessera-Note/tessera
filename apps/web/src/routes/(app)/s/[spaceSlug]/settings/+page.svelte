<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import Button from '$lib/components/ui/Button.svelte';
  import Confirm from '$lib/components/ui/Confirm.svelte';
  import Field from '$lib/components/ui/Field.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import Panel from '$lib/components/ui/Panel.svelte';
  import Select from '$lib/components/ui/Select.svelte';
  import Textarea from '$lib/components/ui/Textarea.svelte';
  import TextInput from '$lib/components/ui/TextInput.svelte';
  import { errorText } from '$lib/api/failure';
  import {
    SPACE_ROLES,
    addSpaceMembers,
    changeSpaceMemberRole,
    deleteSpace,
    removeSpaceMember,
    suggest,
    updateSpace,
    type Suggestion
  } from '$lib/features/space/services/spaces';
  import {
    IMAGE_ACCEPT,
    imageUrl,
    removeIcon,
    uploadImage
  } from '$lib/features/page/services/images';
  import { locale } from '$lib/stores/i18n.svelte';
  import type { PageData } from './$types';

  type Props = { data: PageData };
  const { data }: Props = $props();

  const t = $derived(locale.t);
  const manager = $derived(data.space.role === 'admin');
  const roleOptions = $derived(
    SPACE_ROLES.map((one) => ({ value: one.value, label: t(one.label) }))
  );

  let name = $state('');
  let slug = $state('');
  let description = $state('');
  let query = $state('');
  let role = $state('reader');
  let found = $state<Suggestion>({ users: [], groups: [] });
  let busy = $state<string | null>(null);
  let failure = $state<string | null>(null);
  let saved = $state(false);

  $effect(() => {
    name = data.space.name ?? '';
    slug = data.space.slug;
    description = data.space.description ?? '';
  });

  /** Значок пространства: картинка, а не эмодзи. Хранится файлом. */
  const logo = $derived(imageUrl('space-icon', data.space.logo));

  let picker: HTMLInputElement | undefined = $state();

  const chooseLogo = (event: Event) => {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    return act('logo', async () => {
      await uploadImage('space-icon', file, data.space.id);
      // Значок виден и на этом экране, и в боковой панели: перечитать надо всё.
      await invalidateAll();
      if (picker) picker.value = '';
    });
  };

  const dropLogo = () =>
    act('logo', async () => {
      await removeIcon('space-icon', data.space.id);
      await invalidateAll();
    });

  async function act(key: string, action: () => Promise<unknown>) {
    busy = key;
    failure = null;
    saved = false;
    try {
      await action();
      saved = true;
    } catch (error) {
      failure = errorText(error, t);
    } finally {
      busy = null;
    }
  }

  const save = (event: SubmitEvent) => {
    event.preventDefault();
    return act('general', async () => {
      const updated = await updateSpace({ spaceId: data.space.id, name, slug, description });
      // Короткое имя стоит в адресе: после его смены прежний адрес уже никуда
      // не ведёт, и остаться на нём значит показать отказ.
      if (updated.slug !== data.space.slug) {
        await goto(`/s/${updated.slug}/settings`, { invalidateAll: true });
        return;
      }
      await invalidateAll();
    });
  };

  const remove = () =>
    act('delete', async () => {
      await deleteSpace(data.space.id);
      await goto('/home', { invalidateAll: true });
    });

  const look = (event: SubmitEvent) => {
    event.preventDefault();
    return act('search', async () => {
      found = await suggest(query, { includeUsers: true, includeGroups: true });
    });
  };

  const add = (values: { userIds?: string[]; groupIds?: string[] }) =>
    act('add', async () => {
      await addSpaceMembers({ spaceId: data.space.id, role, ...values });
      query = '';
      found = { users: [], groups: [] };
      await invalidateAll();
    });
</script>

<svelte:head><title>{t('Space settings')} · Tessera</title></svelte:head>

<section data-route="space-settings" class="mx-auto max-w-3xl">
  <h1 class="mb-6 text-2xl font-semibold">{t('Space settings')}</h1>

  {#if failure}<Notice message={failure} />{/if}
  {#if saved && !failure}<Notice tone="info" message={t('Saved')} />{/if}

  <form onsubmit={save}>
    <Panel title={t('Details')}>
      <Field label={t('Space icon')}>
        <div class="flex items-center gap-3">
          {#if logo}
            <img class="h-12 w-12 rounded object-cover" src={logo} alt={t('Space icon')} />
          {:else}
            <span
              class="flex h-12 w-12 items-center justify-center rounded bg-surface-muted text-lg text-text-muted"
              aria-hidden="true"
            >
              {(data.space.name ?? '?').slice(0, 1).toUpperCase()}
            </span>
          {/if}

          {#if manager}
            <!-- Выбор файла спрятан за кнопкой: сам `input type=file` рисуется
                 каждым браузером по-своему и не встаёт в расстановку экрана. -->
            <input
              bind:this={picker}
              class="hidden"
              type="file"
              accept={IMAGE_ACCEPT}
              onchange={chooseLogo}
            />
            <Button variant="quiet" disabled={busy === 'logo'} onclick={() => picker?.click()}>
              {busy === 'logo' ? t('Loading...') : t('Upload')}
            </Button>
            {#if data.space.logo}
              <Button variant="quiet" disabled={busy === 'logo'} onclick={dropLogo}>
                {t('Remove icon')}
              </Button>
            {/if}
          {/if}
        </div>
      </Field>
      <Field label={t('Space name')}>
        <TextInput bind:value={name} placeholder={t('e.g Sales')} disabled={!manager} required />
      </Field>
      <Field label={t('Space slug')}>
        <TextInput bind:value={slug} disabled={!manager} required />
      </Field>
      <Field label={t('Space description')}>
        <Textarea
          bind:value={description}
          placeholder={t('e.g Space for sales team to collaborate')}
          disabled={!manager}
        />
      </Field>
      {#if manager}
        <Button type="submit" disabled={busy === 'general'}>
          {busy === 'general' ? t('Loading...') : t('Save')}
        </Button>
      {/if}
    </Panel>
  </form>

  <Panel title={t('Members')}>
    {#if manager}
      <form class="mb-4 flex flex-wrap items-end gap-2" onsubmit={look}>
        <div class="min-w-64 flex-1">
          <Field label={t('Add space members')}>
            <TextInput bind:value={query} type="search" placeholder={t('Search')} />
          </Field>
        </div>
        <div class="mb-4 w-56"><Select bind:value={role} options={roleOptions} /></div>
        <div class="mb-4">
          <Button type="submit" disabled={busy === 'search'}>{t('Search')}</Button>
        </div>
      </form>

      {#if found.users.length > 0 || found.groups.length > 0}
        <ul class="mb-4 space-y-1 text-sm">
          {#each found.users as one (one.id)}
            <li class="flex items-center justify-between gap-3">
              <span class="truncate">{one.name ?? one.email}</span>
              <Button
                variant="quiet"
                disabled={busy === 'add'}
                onclick={() => add({ userIds: [one.id] })}
              >
                {t('Add')}
              </Button>
            </li>
          {/each}
          {#each found.groups as one (one.id)}
            <li class="flex items-center justify-between gap-3">
              <span class="truncate">{one.name} · {t('Group')}</span>
              <Button
                variant="quiet"
                disabled={busy === 'add'}
                onclick={() => add({ groupIds: [one.id] })}
              >
                {t('Add')}
              </Button>
            </li>
          {/each}
        </ul>
      {:else if query && busy !== 'search'}
        <p class="mb-4 text-sm text-text-muted">{t('No results found')}</p>
      {/if}
    {/if}

    <table data-component="SpaceMemberTable" class="w-full text-left text-sm">
      <thead class="border-b border-border text-text-muted">
        <tr>
          <th class="p-2 font-medium">{t('Name')}</th>
          <th class="p-2 font-medium">{t('Role')}</th>
          <th class="p-2"></th>
        </tr>
      </thead>
      <tbody>
        {#each data.members as member (member.id)}
          <tr class="border-b border-border last:border-0">
            <td class="p-2">
              <p>{member.name ?? member.email ?? t('Unknown')}</p>
              <p class="text-xs text-text-muted">
                {member.type === 'group' ? t('Group') : (member.email ?? t('User'))}
              </p>
            </td>
            <td class="p-2">
              {#if manager}
                <Select
                  compact
                  value={member.role}
                  options={roleOptions}
                  disabled={busy === member.id}
                  onchange={(next) =>
                    act(member.id, async () => {
                      await changeSpaceMemberRole({
                        spaceId: data.space.id,
                        role: next,
                        userId: member.userId ?? undefined,
                        groupId: member.groupId ?? undefined
                      });
                      await invalidateAll();
                    })}
                />
              {:else}
                {t(SPACE_ROLES.find((one) => one.value === member.role)?.label ?? member.role)}
              {/if}
            </td>
            <td class="p-2 text-right">
              {#if manager}
                <Confirm
                  label={t('Remove')}
                  question={t(
                    'Are you sure you want to remove this user from the space? The user will lose all access to this space.'
                  )}
                  disabled={busy === member.id}
                  onconfirm={() =>
                    act(member.id, async () => {
                      await removeSpaceMember({
                        spaceId: data.space.id,
                        userId: member.userId ?? undefined,
                        groupId: member.groupId ?? undefined
                      });
                      await invalidateAll();
                    })}
                />
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </Panel>

  {#if manager}
    <Panel
      title={t('Delete space')}
      hint={t(
        'All pages, comments, attachments and permissions in this space will be deleted irreversibly.'
      )}
    >
      <Confirm
        label={t('Delete space')}
        question={t('Are you sure you want to delete this space?')}
        disabled={busy === 'delete'}
        onconfirm={remove}
      />
    </Panel>
  {/if}
</section>
