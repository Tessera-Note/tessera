import { post } from '$lib/api/client';

/** Одна ссылка на чужой блок: чья страница и какой блок. */
export type ReferenceKey = { sourcePageId: string; transclusionId: string };

/**
 * Ответ на запрос содержимого.
 *
 * Три исхода, и различать их обязательно: «нет доступа» и «блока нет» требуют
 * от человека разных действий — в первом случае просить доступ, во втором
 * убрать ссылку.
 */
export type LookupItem = ReferenceKey & {
  content?: unknown;
  sourceUpdatedAt?: string;
  status?: 'no_access' | 'not_found';
};

export type ReferencePlace = {
  id: string;
  slugId: string;
  title: string | null;
  icon: string | null;
  spaceId: string;
  spaceSlug: string | null;
};

/** Содержимое включённых блоков. Одним запросом на всю страницу. */
export function lookupTransclusions(references: ReferenceKey[], fetcher?: typeof fetch) {
  return post<{ items: LookupItem[] }>(
    '/api/pages/transclusion/lookup',
    { references },
    { fetcher }
  );
}

/** То же на странице, открытой по ссылке: отбор задаёт ключ, а не права. */
export function lookupSharedTransclusions(
  key: string,
  references: ReferenceKey[],
  fetcher?: typeof fetch
) {
  return post<{ items: LookupItem[] }>(
    '/api/share/transclusion/lookup',
    { key, references },
    { fetcher }
  );
}

/** Где ещё показан этот блок. */
export function transclusionReferences(reference: ReferenceKey, fetcher?: typeof fetch) {
  return post<{ source: ReferencePlace | null; references: ReferencePlace[] }>(
    '/api/pages/transclusion/references',
    reference,
    { fetcher }
  );
}

/**
 * Отвязать блок, оставив его содержимое.
 *
 * Возвращается содержимое: узел ссылки заменяет клиент, потому что документ
 * живёт в общем сеансе правки и запись мимо него разошлась бы с тем, что видят
 * соседи.
 */
export function unsyncReference(
  values: ReferenceKey & { referencePageId: string },
  fetcher?: typeof fetch
) {
  return post<{ content: unknown }>('/api/pages/transclusion/unsync-reference', values, {
    fetcher
  });
}
