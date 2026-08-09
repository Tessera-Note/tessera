import { buildWebSearchQuery } from './search-query.util';

/**
 * Просит ли человек изображения.
 *
 * Замерено на живом случае: на просьбу «с описанием и фото» агент поставил
 * ссылку на источник и ни одной картинки, потому что обычный поиск отдает
 * страницы, а не изображения, и картинок ему просто не давали.
 *
 * Списком слов по тем же причинам, что и остальные решения этого рода:
 * отдельный вызов модели удваивает задержку и ломает чат при недоступном
 * провайдере.
 */
/** Сколько слов остается в запросе изображений. */
const IMAGE_QUERY_WORDS = 5;

const IMAGE_MARKERS = [
  'фото',
  'фотк',
  'изображен',
  'картинк',
  'постер',
  'обложк',
  'скрин',
  'photo',
  'image',
  'picture',
  'poster',
  'cover',
  'thumbnail',
];

export function needsImages(query: string): boolean {
  if (!query) return false;

  const text = query.toLowerCase();
  return IMAGE_MARKERS.some((marker) => text.includes(marker));
}

/**
 * Запрос для поиска изображений.
 *
 * Слова про формат («фото», «постеры», «с картинками») описывают не предмет
 * поиска, а то, что с ним сделать, и в запросе изображений только мешают.
 * Остальное берется тем же способом, что и обычный поисковый запрос.
 */
export function buildImageQuery(message: string): string {
  const withoutFormat = message
    .split(/\s+/)
    .filter(
      (word) =>
        !IMAGE_MARKERS.some((marker) => word.toLowerCase().includes(marker)),
    )
    .join(' ');

  const core = buildWebSearchQuery(withoutFormat || message);

  // Длинный запрос изображений сужает выдачу: постеры находятся по названию,
  // а не по всей формулировке просьбы.
  return core.split(' ').slice(0, IMAGE_QUERY_WORDS).join(' ');
}
