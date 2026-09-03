<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import Button from '$lib/components/ui/Button.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import { errorText } from '$lib/api/failure';
  import DocumentView from '$lib/features/editor/DocumentView.svelte';
  import {
    deleteTemplate,
    templateInfo,
    useTemplate,
    type TemplateBody
  } from '$lib/features/template/services/templates';
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
      // Предпросмотр ничего не меняет: перечитывать из-за него нечего.
      if (!key.startsWith('preview:')) await invalidateAll();
    } catch (error) {
      failure = errorText(error, t);
    } finally {
      busy = null;
    }
  }

  /**
   * Предпросмотр перед применением.
   *
   * Содержимое загружается по требованию: перечень его не несёт, а тела
   * шаблонов бывают в сотни килобайт — грузить их все ради того, чтобы человек
   * заглянул в один, значит платить за каждый открытый список.
   */
  let preview = $state<TemplateBody | null>(null);

  function look(templateId: string) {
    return act(`preview:${templateId}`, async () => {
      preview = await templateInfo(templateId);
    });
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
          <div class="flex shrink-0 flex-wrap gap-2">
            <Button
              disabled={busy === template.id || !target}
              onclick={() => apply(template.id, target)}
            >
              {t('Use template')}
            </Button>
            <Button
              variant="quiet"
              disabled={busy === `preview:${template.id}`}
              onclick={() => look(template.id)}
            >
              {t('Preview')}
            </Button>
            <a
              class="inline-flex h-9 items-center justify-center rounded border border-border bg-surface-raised px-[18px] text-sm font-medium hover:bg-surface-hover"
              href="/templates/{template.id}"
            >
              {t('Edit')}
            </a>
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

  {#if preview}
    <!--
      Предпросмотр показывает документ как он есть, а не пересказ текстом:
      шаблон и выбирают по тому, как он выглядит.
    -->
    <div
      class="fixed inset-y-0 right-0 z-40 w-full max-w-2xl overflow-y-auto border-l border-border bg-surface-raised p-5 shadow-lg"
      role="dialog"
      aria-label={preview.title}
    >
      <div class="mb-4 flex items-start gap-2">
        <h2 class="flex-1 text-lg font-medium">
          {#if preview.icon}<span class="mr-1">{preview.icon}</span>{/if}
          {preview.title}
        </h2>
        <button
          class="rounded px-2 py-1 text-sm text-text-muted hover:bg-surface-hover"
          type="button"
          onclick={() => (preview = null)}
        >
          {t('Close')}
        </button>
      </div>
      {#if preview.description}
        <p class="mb-4 text-sm text-text-muted">{preview.description}</p>
      {/if}
      <DocumentView content={preview.content} />
    </div>
  {/if}
</section>
