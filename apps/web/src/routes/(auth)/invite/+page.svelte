<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import Button from '$lib/components/ui/Button.svelte';
  import Field from '$lib/components/ui/Field.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import PasswordInput from '$lib/components/ui/PasswordInput.svelte';
  import TextInput from '$lib/components/ui/TextInput.svelte';
  import { errorText } from '$lib/api/failure';
  import { acceptInvite } from '$lib/features/auth/services/auth';
  import { locale } from '$lib/stores/i18n.svelte';

  let name = $state('');
  let password = $state('');
  let busy = $state(false);
  let failure = $state<string | null>(null);

  const t = $derived(locale.t);
  // Ссылка из письма несёт и приглашение, и его учётные данные: приглашённого
  // в базе ещё нет, и другого способа предъявить себя у него не будет.
  const invitationId = $derived(page.url.searchParams.get('invitationId') ?? '');
  const token = $derived(page.url.searchParams.get('token') ?? '');

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    failure = null;
    try {
      const answer = await acceptInvite({ invitationId, token, name, password });

      // Приём приглашения проходит тем же входом, что и форма входа, поэтому
      // и развилка та же: пространство может требовать второй фактор, и тогда
      // сессии ещё нет.
      if (answer.userHasMfa || answer.requiresMfaSetup) {
        await goto(answer.userHasMfa ? '/login/mfa' : '/login/mfa-setup');
        return;
      }

      await invalidateAll();
      await goto('/home');
    } catch (error) {
      failure = errorText(error, t);
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>{t('Accept invitation')} · Tessera</title></svelte:head>

<form
  data-route="invite"
  class="card-soft rounded border border-border bg-surface-raised p-8 shadow-[0_2px_45px_4px_rgba(0,0,0,0.07)]"
  onsubmit={submit}
>
  <h1 class="mb-6 text-center text-2xl font-medium">{t('Accept invitation')}</h1>

  {#if !invitationId || !token}
    <Notice message={t('The link is invalid or has expired')} />
  {:else}
    <Field label={t('Your name')}>
      <TextInput bind:value={name} autocomplete="name" required />
    </Field>
    <Field label={t('Password')}>
      <PasswordInput bind:value={password} autocomplete="new-password" required />
    </Field>

    {#if failure}<Notice message={failure} />{/if}

    <Button type="submit" wide disabled={busy}
      >{busy ? t('Loading...') : t('Accept invitation')}</Button
    >
  {/if}
</form>
