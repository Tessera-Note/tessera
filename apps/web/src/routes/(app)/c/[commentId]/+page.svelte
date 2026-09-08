<script lang="ts">
  import { locale } from '$lib/stores/i18n.svelte';

  const t = $derived(locale.t);
</script>

<!--
  Показывать здесь нечего: загрузка уводит на страницу с открытым обсуждением.
  Разметка нужна только на тот миг, пока переход не случился, — без неё
  SvelteKit отказывается собирать маршрут.
-->
<p class="text-sm text-text-muted">{t('Loading...')}</p>
