<script lang="ts">
  type Props = {
    value: string;
    rows?: number;
    placeholder?: string;
    disabled?: boolean;
    maxlength?: number;
  };
  let { value = $bindable(), rows = 3, placeholder, disabled = false, maxlength }: Props = $props();
</script>

<textarea
  data-component="Textarea"
  class="w-full rounded border border-border bg-surface px-3 py-2 disabled:opacity-60"
  {rows}
  {placeholder}
  {disabled}
  {maxlength}
  bind:value
></textarea>
