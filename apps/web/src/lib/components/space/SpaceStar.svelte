<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { IconStar, IconStarFilled } from '@tabler/icons-svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import { errorText } from '$lib/api/failure';
  import { addFavoriteSpace, removeFavoriteSpace } from '$lib/features/page/services/favorites';
  import { locale } from '$lib/stores/i18n.svelte';

  type Props = {
    spaceId: string;
    /** Название пространства. Уходит в имя для чтения с экрана, а не на экран. */
    name: string;
    favorited: boolean;
    /** Куда сообщить об отказе. Кнопка сама ничего не показывает: места нет. */
    onfailure?: (message: string) => void;
  };
  const { spaceId, name, favorited, onfailure }: Props = $props();

  const t = $derived(locale.t);

  let busy = $state(false);

  // Имя для чтения с экрана называет пространство: звёзд на экране пространств
  // столько же, сколько строк, и «добавить в избранное» у всех одинаково.
  const label = $derived(
    favorited
      ? t('Remove {{name}} from favorites', { name })
      : t('Add {{name}} to favorites', { name })
  );

  async function toggle() {
    busy = true;
    try {
      await (favorited ? removeFavoriteSpace(spaceId) : addFavoriteSpace(spaceId));
      // Отметка видна в трёх местах сразу — в боковой панели, на экране
      // пространств и в избранном. Перечитывается всё, а не одно из них.
      await invalidateAll();
    } catch (error) {
      onfailure?.(errorText(error, t));
    } finally {
      busy = false;
    }
  }
</script>

<IconButton
  icon={favorited ? IconStarFilled : IconStar}
  {label}
  active={favorited}
  disabled={busy}
  onclick={toggle}
/>
