<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import Button from '$lib/components/ui/Button.svelte';
  import Field from '$lib/components/ui/Field.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import TextInput from '$lib/components/ui/TextInput.svelte';
  import { errorText } from '$lib/api/failure';
  import {
    WORKSPACE_ROLES,
    changeRole,
    invite,
    revokeInvitation,
    setActive
  } from '$lib/features/workspace/services/members';
  import { locale } from '$lib/stores/i18n.svelte';
  import type { PageData } from './$types';

  /** Роль уходит на сервер строчными, а человеку показывается с заглавной. */
  const ROLE_LABELS: Record<string, string> = {
    owner: 'Owner',
    admin: 'Admin',
    member: 'Member'
  };

  type Props = { data: PageData };
  const { data }: Props = $props();

  const t = $derived(locale.t);

  let emails = $state('');
  let inviteRole = $state('member');
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

  function sendInvites(event: SubmitEvent) {
    event.preventDefault();
    // Адреса через запятую или с новой строки: приглашают обычно списком, а
    // не по одному.
    const list = emails
      .split(/[\s,;]+/)
      .map((one) => one.trim())
      .filter(Boolean);
    if (list.length === 0) return;

    return act('invite', async () => {
      await invite(list, inviteRole);
      emails = '';
    });
  }
</script>

<svelte:head><title>{t('Members')} · Tessera</title></svelte:head>

<section data-route="settings-members">
  <h1 class="mb-6 text-2xl font-semibold">{t('Members')}</h1>

  {#if failure}<Notice message={failure} />{/if}

  <form class="mb-8 rounded border border-border bg-surface-raised p-4" onsubmit={sendInvites}>
    <h2 class="mb-4 text-lg font-medium">{t('Invite members')}</h2>

    <Field label={t('Email')}>
      <TextInput bind:value={emails} placeholder="anna@example.com, ivan@example.com" />
    </Field>

    <Field label={t('Role')}>
      <select
        class="h-9 w-full rounded border border-border-input bg-surface px-3 text-sm text-text outline-none focus:border-accent"
        bind:value={inviteRole}
      >
        {#each WORKSPACE_ROLES as role (role)}
          <option value={role}>{t(ROLE_LABELS[role])}</option>
        {/each}
      </select>
    </Field>

    <Button type="submit" disabled={busy === 'invite'}>
      {busy === 'invite' ? t('Loading...') : t('Send invitation')}
    </Button>
  </form>

  <div class="mb-8 rounded border border-border bg-surface-raised">
    <table data-component="MemberTable" class="w-full text-left text-sm">
      <thead class="border-b border-border text-text-muted">
        <tr>
          <th class="p-3 font-medium">{t('Name')}</th>
          <th class="p-3 font-medium">{t('Role')}</th>
          <th class="p-3 font-medium">{t('Status')}</th>
          <th class="p-3"></th>
        </tr>
      </thead>
      <tbody>
        {#each data.members as member (member.id)}
          <tr class="border-b border-border last:border-0">
            <td class="p-3">
              <p class="font-medium">{member.name ?? member.email}</p>
              <p class="text-xs text-text-muted">{member.email}</p>
            </td>
            <td class="p-3">
              <select
                class="h-7 rounded border border-border-input bg-surface px-2 text-sm text-text outline-none focus:border-accent"
                value={member.role ?? 'member'}
                disabled={busy === member.id}
                onchange={(event) =>
                  act(member.id, () =>
                    changeRole(member.id, (event.currentTarget as HTMLSelectElement).value)
                  )}
              >
                {#each WORKSPACE_ROLES as role (role)}
                  <option value={role}>{t(ROLE_LABELS[role])}</option>
                {/each}
              </select>
            </td>
            <td class="p-3 text-text-muted">
              {member.deactivatedAt ? t('Deactivated') : t('Active')}
            </td>
            <td class="p-3 text-right">
              <Button
                variant="quiet"
                disabled={busy === member.id}
                onclick={() => act(member.id, () => setActive(member.id, !!member.deactivatedAt))}
              >
                {member.deactivatedAt ? t('Activate') : t('Deactivate')}
              </Button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>

  {#if data.invitations.length > 0}
    <div class="rounded border border-border bg-surface-raised p-4">
      <h2 class="mb-4 text-lg font-medium">{t('Pending')}</h2>
      <ul class="space-y-2">
        {#each data.invitations as invitation (invitation.id)}
          <li class="flex items-center justify-between gap-4">
            <span class="truncate text-sm">{invitation.email}</span>
            <Button
              variant="quiet"
              disabled={busy === invitation.id}
              onclick={() => act(invitation.id, () => revokeInvitation(invitation.id))}
            >
              {t('Revoke')}
            </Button>
          </li>
        {/each}
      </ul>
    </div>
  {/if}
</section>
