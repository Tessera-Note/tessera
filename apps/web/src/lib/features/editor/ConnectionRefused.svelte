<script lang="ts">
  import Button from '$lib/components/ui/Button.svelte';
  import { locale } from '$lib/stores/i18n.svelte';

  type Props = {
    /** Перезагрузка страницы. Подменяется в проверках: настоящая уводит окно. */
    onreload?: () => void;
  };
  const { onreload = () => window.location.reload() }: Props = $props();

  const t = $derived(locale.t);
</script>

<!--
  Служба редактирования отказала в подключении. Сокет при этом открыт, и
  состояние канала выглядит рабочим, а правки никуда не уходят: без этого блока
  вкладка казалась бы исправной. Так бывает со вкладкой, открытой до
  обновления, — она стучится по старому адресу, — и перезагрузка её чинит.
-->
<div
  data-component="ConnectionRefused"
  class="mb-3 rounded-md border border-border bg-surface-raised p-4"
  role="alert"
>
  <p class="text-sm font-medium text-danger">
    {t(
      'This page is not syncing. Your changes are not reaching other people. Reload the page to reconnect.'
    )}
  </p>
  <div class="mt-3">
    <Button onclick={onreload}>{t('Reload page')}</Button>
  </div>
</div>
