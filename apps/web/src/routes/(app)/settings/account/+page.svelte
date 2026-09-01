<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import Button from '$lib/components/ui/Button.svelte';
  import Field from '$lib/components/ui/Field.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import TextInput from '$lib/components/ui/TextInput.svelte';
  import { errorText } from '$lib/api/failure';
  import { changePassword } from '$lib/features/auth/services/auth';
  import { updateProfile } from '$lib/features/user/services/profile';
  import { LOCALE_NAMES } from '$lib/i18n';
  import { locale } from '$lib/stores/i18n.svelte';
  import type { LayoutData } from '../../$types';

  type Props = { data: LayoutData };
  const { data }: Props = $props();

  const t = $derived(locale.t);

  // Поля формы заводятся от текущих значений и дальше живут своей жизнью:
  // человек их правит. Перечитанные данные подхватываются эффектом ниже, иначе
  // после сохранения в форме осталось бы то, что человек набрал до отказа.
  let name = $state('');
  let chosenLocale = $state('');

  $effect(() => {
    name = data.session?.user.name ?? '';
    chosenLocale = data.session?.user.locale ?? locale.current;
  });
  let profileBusy = $state(false);
  let profileFailure = $state<string | null>(null);
  let profileSaved = $state(false);

  let oldPassword = $state('');
  let newPassword = $state('');
  let passwordBusy = $state(false);
  let passwordFailure = $state<string | null>(null);
  let passwordSaved = $state(false);

  async function saveProfile(event: SubmitEvent) {
    event.preventDefault();
    profileBusy = true;
    profileFailure = null;
    profileSaved = false;
    try {
      await updateProfile({ name, locale: chosenLocale });
      // Язык берётся из учётной записи слоем приложения: без перечитывания
      // страница осталась бы на прежнем языке до перезагрузки.
      await invalidateAll();
      profileSaved = true;
    } catch (error) {
      profileFailure = errorText(error, t);
    } finally {
      profileBusy = false;
    }
  }

  async function savePassword(event: SubmitEvent) {
    event.preventDefault();
    passwordBusy = true;
    passwordFailure = null;
    passwordSaved = false;
    try {
      await changePassword(oldPassword, newPassword);
      oldPassword = '';
      newPassword = '';
      passwordSaved = true;
    } catch (error) {
      passwordFailure = errorText(error, t);
    } finally {
      passwordBusy = false;
    }
  }
</script>

<svelte:head><title>{t('My Profile')} · Tessera</title></svelte:head>

<section data-route="settings-account">
  <h1 class="mb-6 text-2xl font-semibold">{t('My Profile')}</h1>

  <form class="mb-10 rounded-lg border border-border bg-surface-raised p-6" onsubmit={saveProfile}>
    <Field label={t('Name')}>
      <TextInput bind:value={name} autocomplete="name" required />
    </Field>

    <Field label={t('Language')}>
      <select
        data-component="LocaleSelect"
        class="w-full rounded border border-border bg-surface px-3 py-2"
        bind:value={chosenLocale}
      >
        {#each Object.entries(LOCALE_NAMES) as [code, title] (code)}
          <option value={code}>{title}</option>
        {/each}
      </select>
    </Field>

    {#if profileFailure}<Notice message={profileFailure} />{/if}
    {#if profileSaved}<Notice tone="info" message={t('Saved')} />{/if}

    <Button type="submit" disabled={profileBusy}>{profileBusy ? t('Loading...') : t('Save')}</Button
    >
  </form>

  <form class="rounded-lg border border-border bg-surface-raised p-6" onsubmit={savePassword}>
    <h2 class="mb-4 text-lg font-medium">{t('Change password')}</h2>

    <Field label={t('Current password')}>
      <TextInput
        bind:value={oldPassword}
        type="password"
        autocomplete="current-password"
        required
      />
    </Field>
    <Field label={t('New password')}>
      <TextInput bind:value={newPassword} type="password" autocomplete="new-password" required />
    </Field>

    {#if passwordFailure}<Notice message={passwordFailure} />{/if}
    {#if passwordSaved}<Notice tone="info" message={t('Changed password')} />{/if}

    <Button type="submit" disabled={passwordBusy}>
      {passwordBusy ? t('Loading...') : t('Change password')}
    </Button>
  </form>
</section>
