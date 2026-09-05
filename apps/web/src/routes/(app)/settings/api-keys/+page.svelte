<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import Button from '$lib/components/ui/Button.svelte';
  import CopyButton from '$lib/components/ui/CopyButton.svelte';
  import Confirm from '$lib/components/ui/Confirm.svelte';
  import Field from '$lib/components/ui/Field.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import Panel from '$lib/components/ui/Panel.svelte';
  import TextInput from '$lib/components/ui/TextInput.svelte';
  import { errorText } from '$lib/api/failure';
  import {
    createApiKey,
    renameApiKey,
    revokeApiKey,
    type CreatedApiKey
  } from '$lib/features/api-key/services/api-keys';
  import { locale } from '$lib/stores/i18n.svelte';
  import type { PageData } from './$types';

  type Props = { data: PageData };
  const { data }: Props = $props();

  const t = $derived(locale.t);

  let name = $state('');
  let expiresAt = $state('');
  let busy = $state<string | null>(null);
  let failure = $state<string | null>(null);
  let created = $state<CreatedApiKey | null>(null);
  let renaming = $state<string | null>(null);
  let newName = $state('');

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
      // Значение ключа приходит один раз и в базе не хранится: показывается
      // здесь и живёт до ухода с экрана.
      created = await createApiKey({
        name: name.trim(),
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null
      });
      name = '';
      expiresAt = '';
    });
  }

  function rename(event: SubmitEvent, id: string) {
    event.preventDefault();
    if (!newName.trim()) return;
    return act(id, async () => {
      await renameApiKey(id, newName.trim());
      renaming = null;
    });
  }

  const when = (value: string | null | undefined) =>
    value
      ? new Intl.DateTimeFormat(locale.current, { dateStyle: 'medium' }).format(new Date(value))
      : t('Never');

  const expired = (value: string | null | undefined) =>
    !!value && new Date(value).getTime() <= Date.now();
</script>

<svelte:head><title>{t('API keys')} · Tessera</title></svelte:head>

<section data-route="settings-api-keys">
  <h1 class="mb-6 text-2xl font-semibold">{t('API keys')}</h1>

  {#if failure}<Notice message={failure} />{/if}

  {#if created}
    <Panel
      title={t('Created API key')}
      hint={t("Make sure to copy your {{credential}} now. You won't be able to see it again!", {
        credential: t('API key')
      })}
    >
      <p class="mb-3 break-all rounded bg-surface px-3 py-2 font-mono text-sm">{created.token}</p>
      <div class="flex gap-2">
        <CopyButton text={created?.token ?? ''} />
        <Button variant="quiet" onclick={() => (created = null)}>{t('Close')}</Button>
      </div>
    </Panel>
  {/if}

  <form onsubmit={submit}>
    <Panel title={t('Create API Key')}>
      <Field label={t('Name')}>
        <TextInput bind:value={name} placeholder={t('Enter a descriptive token name')} />
      </Field>

      <Field label={t('Expiration')} hint={t('No expiration')}>
        <input
          class="h-9 w-full rounded border border-border-input bg-surface px-3 text-sm text-text outline-none focus:border-accent"
          type="date"
          bind:value={expiresAt}
        />
      </Field>

      <Button type="submit" disabled={busy === 'create'}>
        {busy === 'create' ? t('Loading...') : t('Create')}
      </Button>
    </Panel>
  </form>

  {#if data.admin}
    <p class="mb-4 text-sm">
      <a
        class="hover:underline"
        href={data.all ? '/settings/api-keys' : '/settings/api-keys?all=1'}
      >
        {data.all ? t('API keys') : t('Show all')}
      </a>
    </p>
  {/if}

  <div class="mb-8 card-soft rounded-md border border-border bg-surface-raised">
    <table data-component="ApiKeyTable" class="w-full text-left text-sm">
      <thead class="border-b border-border text-text-muted">
        <tr>
          <th class="p-3 font-medium">{t('Name')}</th>
          <th class="p-3 font-medium">{t('Created')}</th>
          <th class="p-3 font-medium">{t('Expires')}</th>
          <th class="p-3 font-medium">{t('Last used')}</th>
          <th class="p-3"></th>
        </tr>
      </thead>
      <tbody>
        {#each data.keys as key (key.id)}
          <tr class="border-b border-border last:border-0">
            <td class="p-3">
              {#if renaming === key.id}
                <form class="flex gap-2" onsubmit={(event) => rename(event, key.id)}>
                  <TextInput bind:value={newName} />
                  <Button type="submit" disabled={busy === key.id}>{t('Save')}</Button>
                  <Button variant="quiet" onclick={() => (renaming = null)}>{t('Cancel')}</Button>
                </form>
              {:else}
                <span class="font-medium">{key.name}</span>
              {/if}
            </td>
            <td class="p-3 text-text-muted">{when(key.createdAt)}</td>
            <td class="p-3 text-text-muted">
              {when(key.expiresAt)}
              {#if expired(key.expiresAt)}
                <span class="ml-1 text-danger">{t('Expired')}</span>
              {/if}
            </td>
            <td class="p-3 text-text-muted">{when(key.lastUsedAt)}</td>
            <td class="p-3 text-right">
              <span class="inline-flex flex-wrap items-center justify-end gap-2">
                <Button
                  variant="quiet"
                  onclick={() => {
                    renaming = key.id;
                    newName = key.name;
                  }}
                >
                  {t('Rename')}
                </Button>
                <Confirm
                  label={t('Revoke')}
                  question={t(
                    'This action cannot be undone. Any applications using this API key will stop working.'
                  )}
                  disabled={busy === key.id}
                  onconfirm={() => act(key.id, () => revokeApiKey(key.id))}
                />
              </span>
            </td>
          </tr>
        {:else}
          <tr>
            <td class="p-6 text-center text-text-muted" colspan="5">{t('No API keys found')}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</section>
