<script lang="ts">
  /**
   * Подставное тело страницы для проверок печати.
   *
   * Настоящее тянет за собой редактор и грузит его отдельно; проверке важно
   * другое — когда именно показ сообщает о готовности. Здесь этим управляет
   * нажатие.
   */
  type Props = { content?: unknown; onready?: () => void };
  const { onready }: Props = $props();
</script>

<button data-component="ReadyProbe" type="button" onclick={() => onready?.()}>готово</button>
