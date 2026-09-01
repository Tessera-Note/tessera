<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import Button from '$lib/components/ui/Button.svelte';
  import Field from '$lib/components/ui/Field.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import TextInput from '$lib/components/ui/TextInput.svelte';
  import { errorText } from '$lib/api/failure';
  import { createGroup, deleteGroup } from '$lib/features/group/services/groups';
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
        {#each data.groups as group (group.id)}
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
                <Button
                  variant="quiet"
                  disabled={busy === group.id}
                  onclick={() => act(group.id, () => deleteGroup(group.id))}
                >
                  {t('Delete')}
                </Button>
              {/if}
            </td>
          </tr>
        {:else}
          <tr><td class="p-3 text-text-muted" colspan="3">{t('No group found')}</td></tr>
        {/each}
      </tbody>
    </table>
  </div>
</section>
