<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import Button from '$lib/components/ui/Button.svelte';
  import Field from '$lib/components/ui/Field.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import TextInput from '$lib/components/ui/TextInput.svelte';
  import { errorText } from '$lib/api/failure';
  import { SPACE_ROLES, createSpace } from '$lib/features/space/services/spaces';
  import { locale } from '$lib/stores/i18n.svelte';
  import type { PageData } from './$types';

  type Props = { data: PageData };
  const { data }: Props = $props();

  const t = $derived(locale.t);
  // Пространства заводит администратор рабочего пространства, и сервер это
  // проверяет. Форма прячется от остальных, чтобы не предлагать заведомый отказ.
  const admin = $derived(
    data.session?.user.role === 'admin' || data.session?.user.role === 'owner'
  );

  // Подписи ролей берутся оттуда же, откуда их берёт экран доступа: три
  // объявления одного и того же текста разъезжаются при первой же правке.
  // Незнакомая роль остаётся без подписи: показать сырое `writer` хуже, чем
  // не показать ничего.
  function roleLabel(role: string | null): string | null {
    return SPACE_ROLES.find((one) => one.value === role)?.label ?? null;
  }

  let name = $state('');
  let description = $state('');
  let busy = $state(false);
  let failure = $state<string | null>(null);

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!name.trim()) return;

    return (async () => {
      busy = true;
      failure = null;
      try {
        const space = await createSpace({
          name: name.trim(),
          description: description.trim() || undefined
        });
        name = '';
        description = '';
        // Боковая панель берёт список пространств из слоя приложения: без
        // обновления новое пространство появилось бы в ней только после
        // перезагрузки страницы.
        await invalidateAll();
        await goto(`/s/${space.slug}`);
      } catch (error) {
        failure = errorText(error, t);
      } finally {
        busy = false;
      }
    })();
  }
</script>

<svelte:head><title>{t('Spaces')} · Tessera</title></svelte:head>

<section data-route="spaces" class="mx-auto max-w-3xl">
  <h1 class="mb-6 text-2xl font-semibold">{t('Spaces')}</h1>

  {#if failure}<Notice message={failure} />{/if}

  {#if admin}
    <form class="mb-8 rounded border border-border bg-surface-raised p-4" onsubmit={submit}>
      <h2 class="mb-4 text-lg font-medium">{t('Create space')}</h2>

      <Field label={t('Space name')}>
        <TextInput bind:value={name} placeholder={t('e.g Product Team')} />
      </Field>

      <Field label={t('Description')}>
        <TextInput bind:value={description} />
      </Field>

      <Button type="submit" disabled={busy || !name.trim()}>
        {busy ? t('Loading...') : t('Create space')}
      </Button>
    </form>
  {/if}

  <ul data-component="SpaceCards" class="space-y-2">
    {#each data.spaces as space (space.id)}
      {@const label = roleLabel(space.role)}
      <li class="rounded border border-border bg-surface-raised p-4">
        <a class="block" href="/s/{space.slug}">
          <span class="block font-medium">{space.name ?? space.slug}</span>
          {#if space.description}
            <span class="mt-1 block text-sm text-text-muted">{space.description}</span>
          {/if}
        </a>
        {#if label}
          <p class="mt-2 text-xs text-text-muted">{t(label)}</p>
        {/if}
      </li>
    {:else}
      <li class="text-sm text-text-muted">{t('No spaces found')}</li>
    {/each}
  </ul>
</section>
