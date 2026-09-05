import { pagesCreatedBy, recentPages, type PageListing } from '$lib/features/page/services/pages';
import { listFavorites, type Favorite } from '$lib/features/page/services/favorites';
import type { PageServerLoad } from './$types';

/**
 * Три перечня главной, как в v1 (`features/home/components/home-tabs.tsx`):
 * что правили последним, избранное и заведённое самим человеком.
 *
 * Загружаются все три сразу, а не по переключению вкладки: они короткие, а
 * загрузка по щелчку показывала бы пустую вкладку на каждое переключение.
 *
 * Отказ одного перечня не отменяет экран: главная должна открыться и с одним
 * из трёх, иначе сбой в одном запросе прячет и пространства.
 */
export const load: PageServerLoad = async ({ fetch, request }) => {
  const cookie = request.headers.get('cookie');
  const headers = cookie ? { cookie } : undefined;

  const [recent, favorites, mine] = await Promise.all([
    recentPages(null, fetch, headers).catch((): PageListing[] => []),
    listFavorites(fetch, headers).catch((): Favorite[] => []),
    pagesCreatedBy(null, null, fetch, headers).catch((): PageListing[] => [])
  ]);

  return { recent, favorites, mine };
};
