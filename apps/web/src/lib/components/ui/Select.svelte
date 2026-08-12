<script lang="ts">
  type Option = { value: string; label: string };

  type Props = {
    value: string;
    options: Option[];
    disabled?: boolean;
    compact?: boolean;
    /** Подпись для тех, кто не видит соседний текст. */
    label?: string;
    onchange?: (value: string) => void;
  };
  let {
    value = $bindable(),
    options,
    disabled = false,
    compact = false,
    label,
    onchange
  }: Props = $props();
</script>

<select
  data-component="Select"
  class="rounded border border-border bg-surface {compact ? 'px-2 py-1' : 'w-full px-3 py-2'}"
  aria-label={label}
  {disabled}
  bind:value
  onchange={(event) => onchange?.((event.currentTarget as HTMLSelectElement).value)}
>
  {#each options as option (option.value)}
    <option value={option.value}>{option.label}</option>
  {/each}
</select>
