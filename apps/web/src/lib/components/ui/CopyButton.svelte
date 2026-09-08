<script lang="ts">
  import Button from './Button.svelte';
  import { copyText } from '$lib/features/clipboard';
  import { locale } from '$lib/stores/i18n.svelte';

  type Props = {
    /** Что положить в буфер. */
    text: string;
    /** Подпись в спокойном состоянии. По умолчанию «Скопировать». */
    label?: string;
    disabled?: boolean;
  };
  const { text, label, disabled = false }: Props = $props();

  const t = $derived(locale.t);

  let state = $state<'idle' | 'done' | 'failed'>('idle');
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function copy() {
    state = (await copyText(text)) ? 'done' : 'failed';
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => (state = 'idle'), 2000);
  }

  $effect(() => () => {
    if (timer) clearTimeout(timer);
  });
</script>

<!--
  Кнопка отвечает, что случилось. Молчаливое копирование неотличимо от
  несостоявшегося: в незащищённом соединении буфера у браузера нет вовсе.
-->
<Button variant="quiet" {disabled} onclick={copy}>
  {#if state === 'done'}
    {t('Copied')}
  {:else if state === 'failed'}
    {t('Copying failed')}
  {:else}
    {label ?? t('Copy')}
  {/if}
</Button>
