<script lang="ts">
  type Props = {
    checked: boolean;
    label: string;
    /** Что включение меняет на деле. */
    hint?: string;
    disabled?: boolean;
    onchange: (checked: boolean) => void;
  };
  const { checked, label, hint, disabled = false, onchange }: Props = $props();
</script>

<!--
  Обычный флажок, а не рисованный переключатель: он читается доступностью,
  переключается пробелом и не требует своего состояния. Вид здесь ничего не
  решает, а поведение — решает.
-->
<label data-component="Toggle" class="mb-4 flex items-start gap-3">
  <input
    class="mt-1"
    type="checkbox"
    {checked}
    {disabled}
    onchange={(event) => {
      // Флажок возвращается к сохранённому состоянию сразу, а меняется только
      // после ответа сервера, когда обновятся данные страницы. Иначе отказ
      // оставляет на экране включённым то, что включить не удалось.
      const input = event.currentTarget as HTMLInputElement;
      const next = input.checked;
      input.checked = checked;
      onchange(next);
    }}
  />
  <span>
    <span class="block text-sm">{label}</span>
    {#if hint}
      <span class="block text-xs text-text-muted">{hint}</span>
    {/if}
  </span>
</label>
