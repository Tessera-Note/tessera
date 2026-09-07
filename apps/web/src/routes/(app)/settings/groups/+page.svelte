<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import Button from '$lib/components/ui/Button.svelte';
  import Confirm from '$lib/components/ui/Confirm.svelte';
  import Field from '$lib/components/ui/Field.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import TextInput from '$lib/components/ui/TextInput.svelte';
  import { errorText } from '$lib/api/failure';
  import {
    createGroup,
    deleteGroup,
    listGroups,
    type Group
  } from '$lib/features/group/services/groups';
  import { locale } from '$lib/stores/i18n.svelte';
  import type { PageData } from './$types';

  type Props = { data: PageData };
  const { data }: Props = $props();

  const t = $derived(locale.t);
  // Группами распоряжается администратор рабочего пространства, и сервер это
  // проверяет. Читать список вправе каждый: без него не выбрать группу при
  // выдаче доступа.
  const admin = $derived(
    data.session?.user.role === 'admin' || data.session?.user.role === 'owner'
  );

  let name = $state('');
  let description = $state('');
  let busy = $state<string | null>(null);
  let failure = $state<string | null>(null);

  /** Догруженные страницы перечня. Конец виден пустым курсором. */
  let more = $state<Group[]>([]);
  let cursor = $state<string | null>(null);
  let loading = $state(false);
  const groups = $derived([...data.groups, ...more]);

  $effect(() => {
    // Своё состояние сбрасывается вместе с перезагрузкой: заведённая или
    // удалённая группа меняет первую страницу, и догруженное к ней уже не
    // относится.
    void data.groups;
    more = [];
    cursor = data.nextCursor;
  });

  async function loadMore() {
    if (!cursor) return;
    loading = true;
    failure = null;
    try {
      const next = await listGroups({ cursor });
      more = [...more, ...next.items];
      cursor = next.meta.nextCursor;
    } catch (error) {
      failure = errorText(error, t);
    } finally {
      loading = false;
    }
  }

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

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    return act('create', async () => {
      await createGroup(name.trim(), description.trim() || undefined);
      name = '';
      description = '';
    });
  }
</script>

<svelte:head><title>{t('Groups')} · Tessera</title></svelte:head>

<section data-route="settings-groups">
  <h1 class="mb-6 text-2xl font-semibold">{t('Groups')}</h1>

  {#if failure}<Notice message={failure} />{/if}

  {#if admin}
    <form
      class="mb-8 card-soft rounded-md border border-border bg-surface-raised p-5"
      onsubmit={submit}
    >
      <h2 class="mb-4 text-lg font-medium">{t('Create group')}</h2>

      <Field label={t('Group name')}>
        <TextInput bind:value={name} placeholder={t('Group name')} />
      </Field>

      <Field label={t('Description')}>
        <TextInput bind:value={description} />
      </Field>

      <Button type="submit" disabled={busy === 'create' || !name.trim()}>
        {busy === 'create' ? t('Loading...') : t('Create group')}
      </Button>
    </form>
  {/if}

  <div class="card-soft rounded-md border border-border bg-surface-raised">
    <table data-component="GroupTable" class="w-full text-left text-sm">
      <thead class="border-b border-border text-text-muted">
        <tr>
          <th class="p-3 font-medium">{t('Group name')}</th>
          <th class="p-3 font-medium">{t('Members')}</th>
          <th class="p-3"></th>
        </tr>
      </thead>
      <tbody>
        {#each groups as group (group.id)}
          <tr class="border-b border-border last:border-0">
            <td class="p-3">
              {#if admin}
                <a class="font-medium hover:underline" href="/settings/groups/{group.id}">
                  {group.name}
                </a>
              {:else}
                <span class="font-medium">{group.name}</span>
              {/if}
              {#if group.description}
                <p class="text-xs text-text-muted">{group.description}</p>
              {/if}
              {#if group.directorySource}
                <!-- Группу ведёт каталог: правки руками сервер отклонит, и
                     знать об этом надо до попытки, а не после отказа. -->
                <p class="text-xs text-text-muted">{t('Managed by the directory')}</p>
              {/if}
            </td>
            <td class="p-3 text-text-muted">{group.memberCount}</td>
            <td class="p-3 text-right">
              {#if admin && !group.isDefault && !group.directorySource}
                <!-- Вместе с группой уходит доступ у всех, кто в ней
                     состоял: вопрос здесь по делу. -->
                <Confirm
                  label={t('Delete')}
                  question={t(
                    'Are you sure you want to delete this group? Members will lose access to resources this group has access to.'
                  )}
                  disabled={busy === group.id}
                  onconfirm={() => act(group.id, () => deleteGroup(group.id))}
                />
              {/if}
            </td>
          </tr>
        {:else}
          <tr><td class="p-3 text-text-muted" colspan="3">{t('No group found')}</td></tr>
        {/each}
      </tbody>
    </table>
  </div>

  {#if cursor}
    <!-- Без продолжения перечень обрывался бы на потолке выдачи, и молча. -->
    <div class="mt-4">
      <Button variant="quiet" disabled={loading} onclick={loadMore}>
        {loading ? t('Loading...') : t('Load more')}
      </Button>
    </div>
  {/if}
</section>
