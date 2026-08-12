<script lang="ts">
  import Button from './Button.svelte';
  import { locale } from '$lib/stores/i18n.svelte';

  type Props = {
    /** Подпись кнопки в спокойном состоянии. */
    label: string;
    /** Что именно случится. Показывается только после первого нажатия. */
    question: string;
    disabled?: boolean;
    onconfirm: () => void;
  };
  const { label, question, disabled = false, onconfirm }: Props = $props();

  const t = $derived(locale.t);

  let asking = $state(false);
</script>

<!--
  Подтверждение на месте, а не окном поверх экрана. Действия здесь необратимы —
  удаление пространства, отзыв ключа, отключение второго фактора, — и нажатие
  мимо не должно их запускать. Окно потребовало бы ловушки для фокуса и выхода
  по Escape, то есть куда больше кода ради того же одного вопроса.
-->
{#if asking}
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
