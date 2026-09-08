<script lang="ts">
  type Props = { tone?: 'error' | 'info'; message: string };
  const { tone = 'error', message }: Props = $props();
</script>

<p
  data-component="Notice"
  class="mb-4 text-sm {tone === 'error' ? 'text-danger' : 'text-text-muted'}"
  role={tone === 'error' ? 'alert' : undefined}
>
  {message}
</p>
