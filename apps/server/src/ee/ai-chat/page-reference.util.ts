import { validate as isValidUUID } from 'uuid';
import { extractPageSlugId } from '../../integrations/export/utils';

/**
 * Приведение ссылки на страницу к тому, что понимает `PageRepo.findById`.
 *
 * Пользователь внутреннего идентификатора страницы не видит: в интерфейсе
 * такого поля нет вовсе. Он дает то, что у него есть — адрес из строки
 * браузера, адрес общего доступа или хвост адреса. Раньше принимался только
 * идентификатор, и любое из этих значений отбивалось как несуществующая
 * страница.
 *
 * `findById` сам различает UUID и `slug_id`, поэтому задача сводится к тому,
 * чтобы вынуть из ссылки последний сегмент и отрезать от него человекочитаемую
 * часть: `фильмы-pOHJzJpYni` это `pOHJzJpYni`.
 *
 * Поддерживаются:
 * - `019fd2c3-8b03-77e3-9a65-a7714d75494f` — идентификатор;
 * - `pOHJzJpYni` — `slug_id`;
 * - `фильмы-pOHJzJpYni` — слаг целиком;
 * - `http://host/s/general/p/фильмы-pOHJzJpYni` — адрес страницы;
 * - `http://host/share/sgsskwsf71/p/фильмы-pOHJzJpYni` — адрес общего доступа;
 * - те же пути без хоста.
 */
export function normalizePageReference(reference: unknown): string | undefined {
  if (typeof reference !== 'string') return undefined;

  let value = reference.trim();
  if (!value) return undefined;

  // Модель иногда оборачивает ссылку в скобки markdown или кавычки.
  value = value.replace(/^[<("'`]+|[>)"'`]+$/g, '').trim();
  if (!value) return undefined;

  // Отрезаем якорь и параметры: они к идентификации страницы не относятся.
  value = value.split('#')[0].split('?')[0];

  // Идентификатор возвращается как есть: `extractPageSlugId` режет по дефисам
  // и от UUID оставил бы последнюю группу.
  if (isValidUUID(value)) return value;

  if (value.includes('/')) {
    const segments = value.split('/').filter(Boolean);

    // У адреса страницы последний сегмент идет после `/p/`. Берем именно его,
    // а не просто последний: у адреса вида `/s/general/p/` последним окажется
    // пустая строка, отфильтрованная выше, и тогда сегмента страницы нет.
    const pageMarker = segments.lastIndexOf('p');
    const last =
      pageMarker >= 0 && pageMarker < segments.length - 1
        ? segments[pageMarker + 1]
        : segments[segments.length - 1];

    // Адрес без сегмента страницы (`/s/general/p/`) страницы не называет.
    if (!last || last === 'p') return undefined;
    value = last;

    if (isValidUUID(value)) return value;
  }

  const slugId = extractPageSlugId(value);
  return slugId || undefined;
}
