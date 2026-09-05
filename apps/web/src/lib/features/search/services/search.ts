import { post } from '$lib/api/client';

export type SearchHit = {
  id: string;
  slugId: string;
  title: string | null;
  spaceId: string;
  /** Отрывок с подсветкой. Приходит размеченным сервером, а не собирается тут. */
  highlight: string | null;
  rank: number;
};

/**
 * Поиск по страницам.
 *
 * Пространство необязательно: без него ищется по всем доступным. Отбор по
 * правам делает сервер, и повторять его здесь нельзя — разойдясь, второй отбор
 * либо спрячет доступное, либо покажет закрытое.
 */
export function searchPages(
  query: string,
  spaceId?: string | null,
  fetcher?: typeof fetch,
  headers?: Record<string, string>
) {
  return post<SearchHit[]>(
    '/api/search',
    { query, spaceId: spaceId || undefined },
    { fetcher, headers }
  );
}

/** Находка в приложенном файле. Поля другие: находится файл, а не страница. */
export type AttachmentHit = {
  id: string;
  fileName: string;
  pageId: string | null;
  spaceId: string;
  highlight: string | null;
  rank: number;
};

/**
 * Поиск по тексту, извлечённому из вложений.
 *
 * Отдельным обращением, а не признаком у поиска по страницам: у выдачи другой
 * состав полей и другой смысл. Так же на сервере — отдельный маршрут.
 */
/**
 * Разобрать вложения, которые ещё не разбирались.
 *
 * Право администратора: проход читает файлы всего рабочего пространства,
 * включая приложенные к закрытым страницам. Без него поиск по вложениям молча
 * не находит ничего — искать не в чем.
 */
export function indexAttachments(fetcher?: typeof fetch) {
  return post<{ processed: number }>('/api/search-attachments/indexing', {}, { fetcher });
}

export function searchAttachments(query: string, spaceId?: string | null, fetcher?: typeof fetch) {
  return post<AttachmentHit[]>(
    '/api/search-attachments',
    { query, spaceId: spaceId || undefined },
    { fetcher }
  );
}
