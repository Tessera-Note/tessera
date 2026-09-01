<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import Notice from '$lib/components/ui/Notice.svelte';
  import Panel from '$lib/components/ui/Panel.svelte';
  import Select from '$lib/components/ui/Select.svelte';
  import Toggle from '$lib/components/ui/Toggle.svelte';
  import { errorText } from '$lib/api/failure';
  import {
    NOTIFICATION_SWITCHES,
    updateProfile,
    type ProfilePatch
  } from '$lib/features/user/services/profile';
  import { locale } from '$lib/stores/i18n.svelte';
  import type { LayoutData } from '../../$types';

  type Props = { data: LayoutData };
  const { data }: Props = $props();

  const t = $derived(locale.t);

  const preferences = $derived(data.session?.user.settings?.preferences ?? {});
  const notifications = $derived(data.session?.user.settings?.notifications ?? {});

  let failure = $state<string | null>(null);
  let saved = $state(false);

  /** С чего начинается страница: читать или сразу править. */
  const editModes = $derived([
    { value: 'read', label: t('Read') },
    { value: 'edit', label: t('Edit') }
  ]);

  async function save(values: ProfilePatch) {
    failure = null;
    saved = false;
    try {
      await updateProfile(values);
      await invalidateAll();
      saved = true;
    } catch (error) {
      failure = errorText(error, t);
    }
  }

  /**
   * Отсутствие переключателя означает согласие: настройки заводятся при первом
   * отказе, и трактовать пустоту как выключенное было бы неправдой.
   */
  function wants(key: string): boolean {
    return notifications[key] !== false;
  }
</script>

<svelte:head><title>{t('Reading')} · Tessera</title></svelte:head>

<section data-route="settings-preferences">
  <h1 class="mb-6 text-2xl font-semibold">{t('Reading')}</h1>

  {#if failure}<Notice message={failure} />{/if}
  {#if saved}<Notice tone="info" message={t('Saved')} />{/if}

  <Panel>
    <Toggle
      checked={preferences.fullPageWidth === true}
      label={t('Full page width')}
      hint={t('Choose your preferred page width.')}
      onchange={(checked) => save({ fullPageWidth: checked })}
    />
    <Toggle
      checked={preferences.editorToolbar !== false}
      label={t('Fixed editor toolbar')}
      hint={t('Show a formatting toolbar above the editor with quick access to common actions.')}
      onchange={(checked) => save({ editorToolbar: checked })}
    />
    <label class="block">
      <span class="mb-1 block text-sm font-medium text-text">{t('Default page edit mode')}</span>
      <div class="w-56">
        <Select
          value={preferences.pageEditMode ?? 'read'}
          options={editModes}
          onchange={(value) => save({ pageEditMode: value })}
        />
      </div>
    </label>
  </Panel>

  <Panel title={t('Notifications')}>
    {#each NOTIFICATION_SWITCHES as one (one.field)}
      <Toggle
        checked={wants(one.key)}
        label={t(one.label)}
        hint={t(one.hint)}
        onchange={(checked) => save({ [one.field]: checked })}
      />
    {/each}
  </Panel>
</section>
