<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import Button from '$lib/components/ui/Button.svelte';
  import Confirm from '$lib/components/ui/Confirm.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import Panel from '$lib/components/ui/Panel.svelte';
  import Select from '$lib/components/ui/Select.svelte';
  import TextInput from '$lib/components/ui/TextInput.svelte';
  import Textarea from '$lib/components/ui/Textarea.svelte';
  import { errorText } from '$lib/api/failure';
  import EmojiPicker from '$lib/features/editor/EmojiPicker.svelte';
  import PlainEditor from '$lib/features/editor/PlainEditor.svelte';
  import { deleteTemplate, updateTemplate } from '$lib/features/template/services/templates';
  import { locale } from '$lib/stores/i18n.svelte';
  import type { PageData } from './$types';

  type Props = { data: PageData };
  const { data }: Props = $props();

  const t = $derived(locale.t);

  const admin = $derived(
    data.session?.user.role === 'admin' || data.session?.user.role === 'owner'
  );

  let title = $state('');
  let description = $state('');
  let icon = $state<string | null>(null);

  /**
   * Область шаблона.
   *
   * Меняется здесь же: в v1 это выбор в настройках шаблона. Без него шаблон
   * оставался бы в той области, где заведён, навсегда — а заводят его чаще
   * всего из страницы, то есть в её пространстве.
   *
   * Пустое значение означает шаблон рабочего пространства, и оно доступно
   * только администратору: тот же порядок, что при заведении.
   */
  let scope = $state('');

  const scopeOptions = $derived([
    ...(admin ? [{ value: '', label: t('Workspace') }] : []),
    ...data.spaces.map((one) => ({ value: one.id, label: one.name ?? one.slug }))
  ]);

  let choosing = $state(false);
  let busy = $state<string | null>(null);
  let failure = $state<string | null>(null);
  let saved = $state(false);

  /** Тело шаблона живёт внутри редактора и читается вызовом. */
  let body = $state<PlainEditor | null>(null);

  $effect(() => {
    title = data.template.title;
    description = data.template.description ?? '';
    icon = data.template.icon;
    scope = data.template.spaceId ?? '';
  });

  async function act(key: string, action: () => Promise<unknown>) {
    busy = key;
    failure = null;
    saved = false;
    try {
      await action();
      saved = true;
    } catch (error) {
      failure = errorText(error, t);
    } finally {
      busy = null;
    }
  }

  const save = () =>
    act('save', async () => {
      const moved = scope !== (data.template.spaceId ?? '');
      await updateTemplate({
        templateId: data.template.id,
        title: title.trim() || data.template.title,
        description,
        icon: icon ?? '',
        content: body?.content() ?? undefined,
        // Перенос отдельным признаком: пустое значение означает «шаблон
        // рабочего пространства», а не «область не меняем», и без признака
        // сервер не отличил бы одно от другого.
        ...(moved ? { move: true, moveToSpaceId: scope || undefined } : {})
      });
      await invalidateAll();
    });

  const remove = () =>
    act('delete', async () => {
      await deleteTemplate(data.template.id);
      await goto('/templates');
    });
</script>

<svelte:head><title>{data.template.title} · Tessera</title></svelte:head>

<section data-route="template-editor" class="mx-auto max-w-3xl">
  <nav class="mb-4 text-sm text-text-muted">
    <a class="hover:underline" href="/templates">{t('Templates')}</a>
  </nav>

  <h1 class="mb-6 text-2xl font-semibold">{t('Edit template')}</h1>

  {#if failure}<Notice message={failure} />{/if}
  {#if saved && !failure}<Notice tone="info" message={t('Saved')} />{/if}

  <Panel title={t('Details')}>
    <label class="mb-4 block">
      <span class="mb-1 block text-sm text-text-muted">{t('Title')}</span>
      <div class="flex items-center gap-2">
        <div class="relative">
          <button
            class="flex h-9 w-9 items-center justify-center rounded border border-border hover:bg-surface-hover"
            type="button"
            title={t('Choose icon')}
            aria-label={t('Choose icon')}
            aria-expanded={choosing}
            onclick={() => (choosing = !choosing)}
          >
            {icon ?? '📄'}
          </button>
          {#if choosing}
            <EmojiPicker
              current={icon}
              onpick={(picked) => {
                icon = picked;
                choosing = false;
              }}
              onclear={() => {
                icon = null;
                choosing = false;
              }}
              onclose={() => (choosing = false)}
            />
          {/if}
        </div>
        <div class="flex-1"><TextInput bind:value={title} required /></div>
      </div>
    </label>

    <label class="mb-4 block">
      <span class="mb-1 block text-sm text-text-muted">{t('Description')}</span>
      <Textarea bind:value={description} />
    </label>

    <label class="mb-4 block">
      <span class="mb-1 block text-sm text-text-muted">{t('Scope')}</span>
      <Select bind:value={scope} options={scopeOptions} label={t('Scope')} />
      <span class="mt-1 block text-xs text-text-muted">
        {t('Choose which space this template belongs to')}
      </span>
    </label>

    <p class="mb-1 text-sm text-text-muted">{t('Content')}</p>
    <!--
      Совместной правки у шаблона нет: документа Yjs у него нет, его правит один
      человек и сохраняет кнопкой. Поэтому редактор простой.
    -->
    <div class="mb-4 rounded border border-border p-3">
      <PlainEditor
        bind:this={body}
        initial={data.template.content}
        spaceId={data.template.spaceId}
        userId={data.session?.user.id}
        fail={(error) => (failure = errorText(error, t))}
      />
    </div>

    <div class="flex flex-wrap gap-2">
      <Button disabled={busy === 'save' || !title.trim()} onclick={save}>
        {busy === 'save' ? t('Loading...') : t('Save')}
      </Button>
      <!-- Удаление необратимо и спрашивает: в v1 здесь окно вопроса. -->
      <Confirm
        label={t('Delete')}
        question={t('Are you sure you want to delete this template?')}
        disabled={busy === 'delete'}
        onconfirm={remove}
      />
    </div>
  </Panel>
</section>
