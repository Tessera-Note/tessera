<script lang="ts">
  import { imageUrl } from '$lib/features/page/services/images';

  type Props = {
    /** Имя файла из учётной записи либо внешний адрес. Пусто — буква. */
    src?: string | null;
    /**
     * По нему берётся буква и текст всплывающей подсказки. Для чтения с
     * экрана запасной знак скрыт: имя человека всегда стоит текстом рядом, и
     * второе его прочтение только мешает.
     */
    name?: string | null;
    size?: number;
  };
  const { src = null, name = null, size = 32 }: Props = $props();

  const address = $derived(imageUrl('avatar', src));
  const letter = $derived((name ?? '?').trim().slice(0, 1).toUpperCase() || '?');
</script>

<!--
  Картинка или буква. В v1 это `CustomAvatar`, и он стоит везде, где человек
  видит другого человека: список участников, комментарии, сведения о странице.
  Буква — не заглушка, а обычное состояние: аватар ставят не все.
-->
{#if address}
  <img
    data-component="Avatar"
    class="shrink-0 rounded-full object-cover"
    style="width: {size}px; height: {size}px"
    src={address}
    alt={name ?? ''}
  />
{:else}
  <span
    data-component="Avatar"
    class="flex shrink-0 items-center justify-center rounded-full bg-surface-muted font-medium text-text-muted"
    style="width: {size}px; height: {size}px; font-size: {Math.round(size * 0.45)}px"
    title={name ?? ''}
    aria-hidden="true"
  >
    {letter}
  </span>
{/if}
