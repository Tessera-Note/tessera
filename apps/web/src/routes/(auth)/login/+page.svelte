<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import { ApiError } from '$lib/api/client';
  import { login } from '$lib/features/auth/services/auth';
  import { locale } from '$lib/stores/i18n.svelte';

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
      await login(email, password);
      // Вход держится в куке, и данные слоёв надо перечитать: без этого
      // страница остаётся отрисованной для невошедшего.
      await invalidateAll();
      await goto('/home');
    } catch (error) {
      failure =
        error instanceof ApiError ? t(error.code, error.params) : t('Something went wrong');
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>{t('Login')} · Tessera</title></svelte:head>

<form
  data-route="login"
  class="rounded-lg border border-border bg-surface-raised p-8 shadow-sm"
  onsubmit={submit}
>
  <h1 class="mb-6 text-xl font-semibold">{t('Login')}</h1>

  <label class="mb-4 block">
    <span class="mb-1 block text-sm text-text-muted">{t('Email')}</span>
    <input
      class="w-full rounded border border-border bg-surface px-3 py-2"
      type="email"
      autocomplete="username"
      bind:value={email}
      required
    />
  </label>

  <label class="mb-6 block">
    <span class="mb-1 block text-sm text-text-muted">{t('Password')}</span>
    <input
      class="w-full rounded border border-border bg-surface px-3 py-2"
      type="password"
      autocomplete="current-password"
      bind:value={password}
      required
    />
  </label>

  {#if failure}
    <p data-component="LoginError" class="mb-4 text-sm text-danger">{failure}</p>
  {/if}

  <button
    class="w-full rounded bg-accent px-3 py-2 font-medium text-accent-text disabled:opacity-60"
    type="submit"
    disabled={busy}
  >
    {busy ? t('Loading...') : t('Sign In')}
  </button>
</form>
