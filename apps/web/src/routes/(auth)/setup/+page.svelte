<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import Button from '$lib/components/ui/Button.svelte';
  import Field from '$lib/components/ui/Field.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import TextInput from '$lib/components/ui/TextInput.svelte';
  import { errorText } from '$lib/api/failure';
  import { setup } from '$lib/features/auth/services/auth';
  import { locale } from '$lib/stores/i18n.svelte';

  let workspaceName = $state('');
  let name = $state('');
  let email = $state('');
  let password = $state('');
  let busy = $state(false);
  let failure = $state<string | null>(null);

  const t = $derived(locale.t);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    failure = null;
    try {
      await setup({ workspaceName, name, email, password });
      await invalidateAll();
      await goto('/home');
    } catch (error) {
      failure = errorText(error, t);
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>{t('Setup workspace')} · Tessera</title></svelte:head>

<form
  data-route="setup"
  class="rounded border border-border bg-surface-raised p-8 shadow-sm"
  onsubmit={submit}
>
  <h1 class="mb-6 text-xl font-semibold">{t('Setup workspace')}</h1>

  <Field label={t('Workspace Name')}>
    <TextInput bind:value={workspaceName} required />
  </Field>
  <Field label={t('Your name')}>
    <TextInput bind:value={name} autocomplete="name" required />
  </Field>
  <Field label={t('Email')}>
    <TextInput bind:value={email} type="email" autocomplete="username" required />
  </Field>
  <Field label={t('Password')}>
    <TextInput bind:value={password} type="password" autocomplete="new-password" required />
  </Field>

  {#if failure}<Notice message={failure} />{/if}

  <Button type="submit" disabled={busy}>{busy ? t('Loading...') : t('Create workspace')}</Button>
</form>
