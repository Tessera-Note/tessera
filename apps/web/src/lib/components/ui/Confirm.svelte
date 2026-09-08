<script lang="ts">
  import { IconCheck, IconX } from '@tabler/icons-svelte';
  import type { ComponentType } from 'svelte';
  import Button from './Button.svelte';
  import { locale } from '$lib/stores/i18n.svelte';

  type Props = {
    /** Подпись кнопки в спокойном состоянии. */
    label: string;
    /** Что именно случится. Показывается только после первого нажатия. */
    question: string;
    disabled?: boolean;
    /**
     * Значок вместо подписи.
     *
     * Для тесных мест — строки боковой панели, где на слова места нет:
     * подтверждение словами не помещалось, и кнопка «подтвердить» уезжала за
     * край. Вопрос при этом не отменяется: он остаётся вторым нажатием, а
     * текст вопроса уходит в подсказку.
     */
    icon?: ComponentType;
    onconfirm: () => void;
  };
  const { label, question, disabled = false, icon, onconfirm }: Props = $props();

  const t = $derived(locale.t);

  let asking = $state(false);

  const compact = 'flex h-6 w-6 items-center justify-center rounded hover:bg-surface-hover';
</script>

<!--
  Подтверждение на месте, а не окном поверх экрана. Действия здесь необратимы —
  удаление пространства, отзыв ключа, отключение второго фактора, — и нажатие
  мимо не должно их запускать. Окно потребовало бы ловушки для фокуса и выхода
  по Escape, то есть куда больше кода ради того же одного вопроса.
-->
{#if icon}
  {@const Icon = icon}
  <span data-component="Confirm" class="inline-flex shrink-0 items-center gap-0.5">
    {#if asking}
      <button
        class="{compact} text-danger"
        type="button"
        title={question}
        aria-label={question}
        {disabled}
        onclick={() => {
          asking = false;
          onconfirm();
        }}
      >
        <IconCheck size={15} stroke={1.8} />
      </button>
      <button
        class="{compact} text-text-muted hover:text-text"
        type="button"
        title={t('Cancel')}
        aria-label={t('Cancel')}
        onclick={() => (asking = false)}
      >
        <IconX size={15} stroke={1.8} />
      </button>
    {:else}
      <button
        class="{compact} text-text-muted hover:text-text"
        type="button"
        title={label}
        aria-label={label}
        {disabled}
        onclick={() => (asking = true)}
      >
        <Icon size={15} stroke={1.8} />
      </button>
    {/if}
  </span>
{:else if asking}
  <span data-component="Confirm" class="inline-flex flex-wrap items-center gap-2">
    <span class="text-sm text-text-muted">{question}</span>
    <Button
      variant="quiet"
      {disabled}
      onclick={() => {
        asking = false;
        onconfirm();
      }}
    >
      {t('Confirm')}
    </Button>
    <Button variant="quiet" onclick={() => (asking = false)}>{t('Cancel')}</Button>
  </span>
{:else}
  <Button variant="quiet" {disabled} onclick={() => (asking = true)}>
    {label}
  </Button>
{/if}
