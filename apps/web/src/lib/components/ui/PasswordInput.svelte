<script lang="ts">
  import { IconEye, IconEyeOff } from '@tabler/icons-svelte';
  import { locale } from '$lib/stores/i18n.svelte';

  type Props = {
    value: string;
    autocomplete?: AutoFill;
    placeholder?: string;
    required?: boolean;
    disabled?: boolean;
  };
  let {
    value = $bindable(),
    autocomplete,
    placeholder,
    required = false,
    disabled = false
  }: Props = $props();

  const t = $derived(locale.t);

  let shown = $state(false);
</script>

<!--
  Поле пароля с показом набранного, как в v1 (`PasswordInput` Mantine с
  `visibilityToggleButtonProps`). Без него опечатка в длинном пароле видна
  только отказом входа, а исправить её нечем, кроме как набрать заново.
-->
<div data-component="PasswordInput" class="relative">
  {#if shown}
    <input
      class="h-9 w-full rounded border border-border-input bg-surface pl-3 pr-10 text-sm text-text outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft disabled:opacity-70"
      type="text"
      {autocomplete}
      {placeholder}
      {required}
      {disabled}
      bind:value
    />
  {:else}
    <input
      class="h-9 w-full rounded border border-border-input bg-surface pl-3 pr-10 text-sm text-text outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft disabled:opacity-70"
      type="password"
      {autocomplete}
      {placeholder}
      {required}
      {disabled}
      bind:value
    />
  {/if}

  <button
    class="absolute right-0 top-0 flex h-9 w-9 items-center justify-center text-text-muted hover:text-text"
    type="button"
    aria-label={t('Toggle password visibility')}
    aria-pressed={shown}
    tabindex="0"
    onclick={() => (shown = !shown)}
  >
    {#if shown}
      <IconEyeOff size={16} stroke={1.7} />
    {:else}
      <IconEye size={16} stroke={1.7} />
    {/if}
  </button>
</div>
