<script lang="ts">
  /**
   * Слой приложения в объёме, который важен хранилищу языка.
   *
   * Настоящий `+layout.svelte` в проверку не берётся: он тянет за собой
   * маршрутизацию и стили. Здесь оставлено ровно то, что вызвало отказ —
   * вызов `locale.apply` из эффекта и показ, зависящий от словаря.
   */
  import { locale } from '$lib/stores/i18n.svelte';
  import type { Dictionary } from '$lib/i18n';

  type Props = { current: string; dictionary: Dictionary };
  const { current, dictionary }: Props = $props();

  $effect(() => {
    locale.apply(current, dictionary);
  });
</script>

<p data-component="LocaleEffectProbe">{locale.t('Loading...')}</p>
