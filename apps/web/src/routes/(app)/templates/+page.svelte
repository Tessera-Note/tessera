<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import { IconStar, IconStarFilled } from '@tabler/icons-svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import PagePicker from '$lib/components/page/PagePicker.svelte';
  import {
    addFavoriteTemplate,
    removeFavoriteTemplate
  } from '$lib/features/page/services/favorites';
  import Confirm from '$lib/components/ui/Confirm.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import Select from '$lib/components/ui/Select.svelte';
  import TextInput from '$lib/components/ui/TextInput.svelte';
  import { errorText } from '$lib/api/failure';
  import DocumentView from '$lib/features/editor/DocumentView.svelte';
  import {
    createTemplate,
    deleteTemplate,
    listTemplates,
    templateInfo,
    useTemplate,
    type Template,
    type TemplateBody
  } from '$lib/features/template/services/templates';
  import { locale } from '$lib/stores/i18n.svelte';
  import type { PageData } from './$types';

  type Props = { data: PageData };
  const { data }: Props = $props();

  const t = $derived(locale.t);

  const admin = $derived(
    data.session?.user.role === 'admin' || data.session?.user.role === 'owner'
  );

  /**
   * Кому показывать заведение шаблона.
   *
   * Правило то же, что проверяет сервер: администратор рабочего пространства
   * либо участник при включённом признаке. Иначе кнопка обещала бы то, на что
   * ответом будет отказ.
   */
  const canCreate = $derived(admin || data.session?.workspace.allowMemberTemplates === true);

  /** Кому показывать правку и удаление. В v1 это администратор пространства. */
  const canManage = $derived(admin);

  /**
   * Отбор по области.
   *
   * Запросом, а не здесь: выдача постраничная, и отобранная на месте страница
   * выходила бы пустой при том, что подходящие шаблоны есть дальше. Отбор
   * живёт в адресе, поэтому смена перезагружает перечень.
   */
  const filter = $derived(data.spaceId ?? '');

  /** Догруженные страницы перечня. */
  let more = $state<Template[]>([]);
  let cursor = $state<string | null>(null);
  const shown = $derived([...data.templates, ...more]);

  $effect(() => {
    // Своё состояние сбрасывается вместе с перезагрузкой перечня: догруженное
    // относилось к прежнему отбору.
    void data.templates;
    more = [];
    cursor = data.nextCursor;
  });

  async function loadMore() {
    if (!cursor) return;
    busy = 'more';
    failure = null;
    try {
      const next = await listTemplates({ spaceId: data.spaceId, cursor });
      more = [...more, ...next.items];
      cursor = next.meta.nextCursor;
    } catch (error) {
      failure = errorText(error, t);
    } finally {
      busy = null;
    }
  }

  /**
   * Отмеченные шаблоны идут первыми.
   *
   * В v1 отдельного раздела под них нет, а перечень длинный: часто применяемый
   * шаблон приходилось искать глазами наравне с заведённым однажды. Порядок
   * устойчив, сравнение смотрит только на отметку.
   */
  const favorited = $derived(new Set(data.favorites.map((one) => one.templateId)));
  const ordered = $derived(
    [...shown].sort((a, b) => Number(favorited.has(b.id)) - Number(favorited.has(a.id)))
  );

  function toggleFavorite(template: Template) {
    return act(`star:${template.id}`, () =>
      favorited.has(template.id)
        ? removeFavoriteTemplate(template.id)
        : addFavoriteTemplate(template.id)
    );
  }

  const spaceOptions = $derived([
    { value: '', label: t('All templates') },
    ...data.spaces.map((one) => ({ value: one.id, label: one.name ?? one.slug }))
  ]);

  /** Области, куда можно завести шаблон. Общая — только у администратора. */
  const scopeOptions = $derived([
    ...(admin ? [{ value: '', label: t('Workspace') }] : []),
    ...data.spaces.map((one) => ({ value: one.id, label: one.name ?? one.slug }))
  ]);

  let busy = $state<string | null>(null);
  let failure = $state<string | null>(null);

  function spaceSlug(spaceId: string): string | undefined {
    return data.spaces.find((one) => one.id === spaceId)?.slug;
  }

  function spaceName(spaceId: string): string | undefined {
    const found = data.spaces.find((one) => one.id === spaceId);
    return found ? (found.name ?? found.slug) : undefined;
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
   * Заведение шаблона с чистого листа.
   *
   * В v1 это отдельное окно с названием и областью, и оно нужно: пустой шаблон
   * без области сервер не примет, а название — единственное, по чему шаблон
   * потом находят в перечне. Остальное правится на экране шаблона.
   */
  let adding = $state(false);
  let newTitle = $state('');
  let newScope = $state('');

  function startAdding() {
    adding = true;
    newTitle = '';
    // Участнику общая область недоступна: подставляется первое пространство.
    newScope = admin ? '' : (data.spaces[0]?.id ?? '');
  }

  function add() {
    const title = newTitle.trim();
    if (!title) return;
    return act('create', async () => {
      const made = await createTemplate({ title, spaceId: newScope || undefined });
      adding = false;
      await goto(`/templates/${made.id}`);
    });
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

  /**
   * Куда заводить страницу.
   *
   * Спрашивается всегда, как в v1 (`use-template-modal.tsx`): даже у шаблона
   * пространства выбор не предрешён — внутри пространства страница может быть
   * и корневой, и вложенной, а без вопроса она всегда падала в корень.
   */
  let choosing = $state<Template | null>(null);
  let target = $state('');
  /** Родительская страница. Пусто — корень пространства. */
  let parent = $state<{ id: string; title: string | null } | null>(null);

  function start(template: Template) {
    choosing = template;
    target = template.spaceId ?? data.spaces[0]?.id ?? '';
    parent = null;
  }

  function apply(templateId: string, spaceId: string) {
    return act(templateId, async () => {
      const made = await useTemplate({
        templateId,
        spaceId,
        parentPageId: parent?.id
      });
      choosing = null;
      parent = null;
      const slug = spaceSlug(made.spaceId);
      if (slug) await goto(`/s/${slug}/p/${made.slugId}`);
    });
  }
</script>

<svelte:head><title>{t('Templates')} · Tessera</title></svelte:head>

<section data-route="templates" class="mx-auto max-w-3xl">
  <div class="mb-6 flex items-center justify-between gap-4">
    <h1 class="text-2xl font-semibold">{t('Templates')}</h1>
    {#if canCreate && !adding}
      <Button onclick={startAdding}>{t('New template')}</Button>
    {/if}
  </div>

  {#if failure}<Notice message={failure} />{/if}

  {#if adding}
    <form
      class="mb-6 card-soft rounded-md border border-border bg-surface-raised p-5"
      onsubmit={(event) => {
        event.preventDefault();
        add();
      }}
    >
      <h2 class="mb-4 text-lg font-medium">{t('New template')}</h2>

      <label class="mb-4 block">
        <span class="mb-1 block text-sm text-text-muted">{t('Title')}</span>
        <TextInput bind:value={newTitle} placeholder={t('Untitled')} required />
      </label>

      <label class="mb-4 block">
        <span class="mb-1 block text-sm text-text-muted">{t('Scope')}</span>
        <Select bind:value={newScope} options={scopeOptions} label={t('Scope')} />
        <span class="mt-1 block text-xs text-text-muted">
          {t('Choose which space this template belongs to')}
        </span>
      </label>

      <div class="flex gap-2">
        <Button type="submit" disabled={busy === 'create' || !newTitle.trim()}>
          {busy === 'create' ? t('Loading...') : t('Create')}
        </Button>
        <Button variant="quiet" onclick={() => (adding = false)}>{t('Cancel')}</Button>
      </div>
    </form>
  {/if}

  <label class="mb-6 block">
    <span class="mb-1 block text-sm text-text-muted">{t('Filter by space')}</span>
    <Select
      value={filter}
      options={spaceOptions}
      label={t('Filter by space')}
      onchange={(next) => goto(next ? `/templates?spaceId=${next}` : '/templates')}
    />
  </label>

  <ul data-component="TemplateList" class="space-y-2">
    {#each ordered as template (template.id)}
      <li class="card-soft rounded-md border border-border bg-surface-raised p-5">
        <!--
          Название сверху, действия под ним. В строку они не встают: их четыре,
          и вместе они забирали всю ширину — от названия оставалось три знака с
          многоточием.
        -->
        <div>
          <div class="flex min-w-0 items-start justify-between gap-2">
            <div class="min-w-0">
              <p class="font-medium">
                {#if template.icon}<span class="mr-1">{template.icon}</span>{/if}
                {template.title}
              </p>
              {#if template.description}
                <p class="mt-1 text-sm text-text-muted">{template.description}</p>
              {/if}
              <p class="mt-1 text-xs text-text-muted">
                {template.spaceId ? (spaceName(template.spaceId) ?? t('Space')) : t('Workspace')}
              </p>
            </div>
            <!-- Звезда отдельно от действий: она не применяет шаблон, а
                 поднимает его в перечне. -->
            <IconButton
              icon={favorited.has(template.id) ? IconStarFilled : IconStar}
              label={favorited.has(template.id)
                ? t('Remove from favorites')
                : t('Add to favorites')}
              active={favorited.has(template.id)}
              disabled={busy === `star:${template.id}`}
              onclick={() => toggleFavorite(template)}
            />
          </div>
          <div class="mt-3 flex flex-wrap gap-2">
            <Button disabled={busy === template.id} onclick={() => start(template)}>
              {t('Use template')}
            </Button>
            <Button
              variant="quiet"
              disabled={busy === `preview:${template.id}`}
              onclick={() => look(template.id)}
            >
              {t('Preview')}
            </Button>
            {#if canManage}
              <a
                class="inline-flex h-9 items-center justify-center rounded border border-border bg-surface-raised px-[18px] text-sm font-medium hover:bg-surface-hover"
                href="/templates/{template.id}"
              >
                {t('Edit')}
              </a>
              <!-- Удаление необратимо и спрашивает: в v1 здесь окно вопроса. -->
              <Confirm
                label={t('Delete')}
                question={t('Are you sure you want to delete this template?')}
                disabled={busy === template.id}
                onconfirm={() => act(template.id, () => deleteTemplate(template.id))}
              />
            {/if}
          </div>
        </div>

        {#if choosing?.id === template.id}
          <!-- Выбор назначения: пространство и, необязательно, родительская
               страница. Без второго страница всегда падала в корень, хотя
               применяют шаблон чаще всего внутри уже заведённого раздела. -->
          <div class="mt-4 space-y-3 border-t border-border pt-4">
            <label class="block">
              <span class="mb-1 block text-sm text-text-muted">{t('Choose destination')}</span>
              <Select
                value={target}
                options={data.spaces.map((one) => ({
                  value: one.id,
                  label: one.name ?? one.slug
                }))}
                label={t('Choose destination')}
                onchange={(next) => {
                  target = next;
                  // Родитель относился к прежнему пространству: страница из
                  // соседнего родителем здесь быть не может.
                  parent = null;
                }}
              />
            </label>

            {#if target}
              <PagePicker spaceId={target} value={parent} onpick={(one) => (parent = one)} />
            {/if}

            <div class="flex flex-wrap gap-2">
              <Button
                disabled={busy === template.id || !target}
                onclick={() => apply(template.id, target)}
              >
                {t('Create page')}
              </Button>
              <Button variant="quiet" onclick={() => (choosing = null)}>{t('Cancel')}</Button>
            </div>
          </div>
        {/if}
      </li>
    {:else}
      <li class="text-sm text-text-muted">{t('No templates found')}</li>
    {/each}
  </ul>

  {#if cursor}
    <!--
      Перечень отдаётся страницами: без продолжения рабочее пространство с
      сотнями шаблонов показывало бы только первые полсотни, и молча.
    -->
    <div class="mt-4">
      <Button variant="quiet" disabled={busy === 'more'} onclick={loadMore}>
        {busy === 'more' ? t('Loading...') : t('Load more')}
      </Button>
    </div>
  {/if}

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
