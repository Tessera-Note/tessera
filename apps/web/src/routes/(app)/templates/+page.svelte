<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import Button from '$lib/components/ui/Button.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import { errorText } from '$lib/api/failure';
  import { deleteTemplate, useTemplate } from '$lib/features/template/services/templates';
  import { locale } from '$lib/stores/i18n.svelte';
  import type { PageData } from './$types';

  type Props = { data: PageData };
  const { data }: Props = $props();

  const t = $derived(locale.t);

  // Куда заводить страницу. Шаблон рабочего пространства сам области не знает,
  // а у шаблона области выбор предрешён — он и подставляется.
  let chosenSpace = $state('');
  let busy = $state<string | null>(null);
  let failure = $state<string | null>(null);

  function spaceFor(templateSpaceId: string | null): string {
    return templateSpaceId ?? chosenSpace;
  }

  function spaceSlug(spaceId: string): string | undefined {
    return data.spaces.find((one) => one.id === spaceId)?.slug;
  }

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

  function apply(templateId: string, spaceId: string) {
    return act(templateId, async () => {
      const page = await useTemplate({ templateId, spaceId });
      const slug = spaceSlug(page.spaceId);
      if (slug) await goto(`/s/${slug}/p/${page.slugId}`);
    });
  }
</script>

<svelte:head><title>{t('Templates')} · Tessera</title></svelte:head>

<section data-route="templates" class="mx-auto max-w-3xl">
  <h1 class="mb-6 text-2xl font-semibold">{t('Templates')}</h1>

  {#if failure}<Notice message={failure} />{/if}

  <label class="mb-6 block">
    <span class="mb-1 block text-sm text-text-muted">{t('Space')}</span>
    <select
      class="h-9 w-full rounded border border-border-input bg-surface px-3 text-sm text-text outline-none focus:border-accent"
      bind:value={chosenSpace}
    >
      <option value="">{t('Select scope')}</option>
      {#each data.spaces as space (space.id)}
        <option value={space.id}>{space.name ?? space.slug}</option>
      {/each}
    </select>
  </label>

  <ul data-component="TemplateList" class="space-y-2">
    {#each data.templates as template (template.id)}
      {@const target = spaceFor(template.spaceId)}
      <li class="card-soft rounded-md border border-border bg-surface-raised p-5">
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <p class="truncate font-medium">
              {#if template.icon}<span class="mr-1">{template.icon}</span>{/if}
              {template.title}
            </p>
            {#if template.description}
              <p class="mt-1 text-sm text-text-muted">{template.description}</p>
            {/if}
            <p class="mt-1 text-xs text-text-muted">
              {template.spaceId
                ? (data.spaces.find((one) => one.id === template.spaceId)?.name ?? t('Space'))
                : t('Workspace')}
            </p>
          </div>
          <div class="flex shrink-0 gap-2">
            <Button
              disabled={busy === template.id || !target}
              onclick={() => apply(template.id, target)}
            >
              {t('Use template')}
            </Button>
            <Button
              variant="quiet"
              disabled={busy === template.id}
              onclick={() => act(template.id, () => deleteTemplate(template.id))}
            >
              {t('Delete')}
            </Button>
          </div>
        </div>
      </li>
    {:else}
      <li class="text-sm text-text-muted">{t('No templates found')}</li>
    {/each}
  </ul>
</section>
