<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import Button from '$lib/components/ui/Button.svelte';
  import Field from '$lib/components/ui/Field.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import TextInput from '$lib/components/ui/TextInput.svelte';
  import { errorText } from '$lib/api/failure';
  import { changePassword } from '$lib/features/auth/services/auth';
  import { updateProfile } from '$lib/features/user/services/profile';
  import {
    IMAGE_ACCEPT,
    imageUrl,
    removeIcon,
    uploadImage
  } from '$lib/features/page/services/images';
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
  let passwordSaved = $state(false);

  /**
   * Сообщение об успехе гаснет само.
   *
   * «Сохранено» висело до ухода с экрана и через минуту относилось уже
   * неизвестно к чему: человек успевал поправить поля заново.
   */
  function fades(set: (value: boolean) => void) {
    set(true);
    setTimeout(() => set(false), 4000);
  }

  /**
   * Аватар учётной записи.
   *
   * В v1 он стоит первым на этом экране (`features/user/components/
   * account-avatar.tsx`), здесь его не было вовсе: имя человека в комментариях
   * и в списке участников показывалось буквой, а сменить картинку было негде,
   * хотя маршрут загрузки на сервере есть.
   */
  let picker: HTMLInputElement | undefined = $state();
  let avatarBusy = $state(false);
  const avatar = $derived(imageUrl('avatar', data.session?.user.avatarUrl));

  async function chooseAvatar(event: Event) {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    avatarBusy = true;
    profileFailure = null;
    try {
      await uploadImage('avatar', file);
      await invalidateAll();
    } catch (error) {
      profileFailure = errorText(error, t);
    } finally {
      avatarBusy = false;
      // Поле сбрасывается: иначе тот же файл вторым выбором не даст события.
      if (picker) picker.value = '';
    }
  }

  async function dropAvatar() {
    avatarBusy = true;
    profileFailure = null;
    try {
      await removeIcon('avatar');
      await invalidateAll();
    } catch (error) {
      profileFailure = errorText(error, t);
    } finally {
      avatarBusy = false;
    }
  }

  let oldPassword = $state('');
  let newPassword = $state('');
  let passwordBusy = $state(false);
  let passwordFailure = $state<string | null>(null);

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
      fades((value) => (profileSaved = value));
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
      fades((value) => (passwordSaved = value));
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

  <form
    class="mb-10 card-soft rounded-md border border-border bg-surface-raised p-5"
    onsubmit={saveProfile}
  >
    <Field label={t('Avatar')}>
      <div class="flex items-center gap-3">
        {#if avatar}
          <img class="h-16 w-16 rounded-full object-cover" src={avatar} alt={t('Avatar')} />
        {:else}
          <span
            class="flex h-16 w-16 items-center justify-center rounded-full bg-surface-muted text-xl text-text-muted"
            aria-hidden="true"
          >
            {(data.session?.user.name ?? data.session?.user.email ?? '?').slice(0, 1).toUpperCase()}
          </span>
        {/if}

        <!-- Выбор файла спрятан за кнопкой: сам `input type=file` рисуется
             каждым браузером по-своему и не встаёт в расстановку экрана. -->
        <input
          bind:this={picker}
          class="hidden"
          type="file"
          accept={IMAGE_ACCEPT}
          onchange={chooseAvatar}
        />
        <Button variant="quiet" disabled={avatarBusy} onclick={() => picker?.click()}>
          {avatarBusy ? t('Loading...') : t('Upload')}
        </Button>
        {#if data.session?.user.avatarUrl}
          <Button variant="quiet" disabled={avatarBusy} onclick={dropAvatar}>
            {t('Remove icon')}
          </Button>
        {/if}
      </div>
    </Field>

    <Field label={t('Name')}>
      <TextInput bind:value={name} autocomplete="name" required />
    </Field>

    <!--
      Почта показана, но не правится: в v1 кнопка смены закомментирована, и
      маршрута под неё нет ни там, ни здесь. Показать её всё равно надо — по
      ней человек понимает, под какой учётной записью работает.
    -->
    <Field label={t('Email')}>
      <p class="text-sm text-text-muted">{data.session?.user.email}</p>
    </Field>

    <Field label={t('Language')}>
      <select
        data-component="LocaleSelect"
        class="h-9 w-full rounded border border-border-input bg-surface px-3 text-sm text-text outline-none focus:border-accent"
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

  <form
    class="card-soft rounded-md border border-border bg-surface-raised p-5"
    onsubmit={savePassword}
  >
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
