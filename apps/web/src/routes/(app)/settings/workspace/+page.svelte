<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import Button from '$lib/components/ui/Button.svelte';
  import Field from '$lib/components/ui/Field.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import Panel from '$lib/components/ui/Panel.svelte';
  import Textarea from '$lib/components/ui/Textarea.svelte';
  import TextInput from '$lib/components/ui/TextInput.svelte';
  import Toggle from '$lib/components/ui/Toggle.svelte';
  import { errorText } from '$lib/api/failure';
  import { updateWorkspace, type WorkspacePatch } from '$lib/features/workspace/services/settings';
  import { locale } from '$lib/stores/i18n.svelte';
  import type { PageData } from './$types';

  type Props = { data: PageData };
  const { data }: Props = $props();

  const t = $derived(locale.t);

  let name = $state('');
  let description = $state('');
  let retention = $state('');
  let busy = $state<string | null>(null);
  let failure = $state<string | null>(null);
  let saved = $state(false);

  // Значения формы приходят с сервера и обновляются после сохранения: разовое
  // присваивание оставило бы на экране прежние после чужой правки.
  $effect(() => {
    name = data.settings.name ?? '';
    description = data.settings.description ?? '';
    retention = String(data.settings.trashRetentionDays ?? '');
  });

  async function save(key: string, values: WorkspacePatch) {
    busy = key;
    failure = null;
    saved = false;
    try {
      await updateWorkspace(values);
      saved = true;
      await invalidateAll();
    } catch (error) {
      failure = errorText(error, t);
    } finally {
      busy = null;
    }
  }

  const saveGeneral = (event: SubmitEvent) => {
    event.preventDefault();
    return save('general', { name, description });
  };

  const saveRetention = (event: SubmitEvent) => {
    event.preventDefault();
    return save('retention', { trashRetentionDays: Number(retention) });
  };
</script>

<svelte:head><title>{t('Workspace settings')} · Tessera</title></svelte:head>

<section data-route="settings-workspace">
  <h1 class="mb-6 text-2xl font-semibold">{t('Workspace settings')}</h1>

  {#if failure}<Notice message={failure} />{/if}
  {#if saved && !failure}<Notice tone="info" message={t('Saved')} />{/if}

  <form onsubmit={saveGeneral}>
    <Panel title={t('General')}>
      <Field label={t('Name')}>
        <TextInput bind:value={name} required />
      </Field>
      <Field label={t('Description')}>
        <Textarea bind:value={description} />
      </Field>
      <Button type="submit" disabled={busy === 'general'}>
        {busy === 'general' ? t('Loading...') : t('Save')}
      </Button>
    </Panel>
  </form>

  <Panel title={t('Security')}>
    <Toggle
      checked={data.settings.enforceMfa}
      label={t('Enforce two-factor authentication')}
      hint={t(
        'Once enforced, all members must enable two-factor authentication to access the workspace.'
      )}
      disabled={busy === 'enforceMfa'}
      onchange={(checked) => save('enforceMfa', { enforceMfa: checked })}
    />

    <Toggle
      checked={data.settings.enforceSso}
      label={t('Enforce SSO')}
      hint={t('Once enforced, members will not be able to login with email and password.')}
      disabled={busy === 'enforceSso'}
      onchange={(checked) => save('enforceSso', { enforceSso: checked })}
    />

    <Toggle
      checked={data.settings.disablePublicSharing}
      label={t('Disable public sharing')}
      disabled={busy === 'disablePublicSharing'}
      onchange={(checked) => save('disablePublicSharing', { disablePublicSharing: checked })}
    />

    <Toggle
      checked={data.settings.restrictApiToAdmins}
      label={t('Restrict API key creation to admins')}
      hint={t(
        'Only admins and owners can create new API keys. Existing member keys will continue to work.'
      )}
      disabled={busy === 'restrictApiToAdmins'}
      onchange={(checked) => save('restrictApiToAdmins', { restrictApiToAdmins: checked })}
    />

    <Toggle
      checked={data.settings.allowMemberTemplates}
      label={t('Allow members to create templates')}
      disabled={busy === 'allowMemberTemplates'}
      onchange={(checked) => save('allowMemberTemplates', { allowMemberTemplates: checked })}
    />
  </Panel>

  <form onsubmit={saveRetention}>
    <Panel title={t('Trash retention')}>
      <Field
        label={t('Days')}
        hint={t('Pages in trash will be permanently deleted after {{count}} days.', {
          count: Number(retention) || 0
        })}
      >
        <TextInput bind:value={retention} />
      </Field>
      <Button type="submit" disabled={busy === 'retention'}>
        {busy === 'retention' ? t('Loading...') : t('Save')}
      </Button>
    </Panel>
  </form>
</section>
