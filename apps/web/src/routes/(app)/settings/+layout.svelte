<script lang="ts">
  import { page } from '$app/state';
  import { locale } from '$lib/stores/i18n.svelte';
  import type { Snippet } from 'svelte';

  type Props = { children: Snippet };
  const { children }: Props = $props();

  const t = $derived(locale.t);
  const sections = $derived([
    { href: '/settings/account', label: t('My Profile') },
    { href: '/settings/security', label: t('2-step verification') },
    { href: '/settings/api-keys', label: t('API keys') },
    { href: '/settings/members', label: t('Members') },
    { href: '/settings/groups', label: t('Groups') },
    { href: '/settings/workspace', label: t('Workspace settings') },
    { href: '/settings/ai', label: t('AI') },
    { href: '/settings/sharing', label: t('Public sharing') },
    { href: '/settings/verifications', label: t('Page verification') },
    { href: '/settings/audit', label: t('Audit log') }
  ]);
</script>

<div data-section="settings" class="mx-auto flex max-w-4xl gap-8">
  <nav class="w-48 shrink-0 space-y-1">
    {#each sections as section (section.href)}
      <a
        class="block rounded px-2 py-1.5 text-sm hover:bg-surface"
        class:font-medium={page.url.pathname === section.href}
        href={section.href}
      >
        {section.label}
      </a>
    {/each}
  </nav>
  <div class="min-w-0 flex-1">{@render children()}</div>
</div>
