import { post } from '$lib/api/client';

export type PageSummary = {
  id: string;
  slugId: string;
  title: string | null;
  icon: string | null;
  parentPageId: string | null;
  spaceId: string;
  /** Ключ порядка среди соседей. Пустой у страницы, которую ещё не двигали. */
  position?: string | null;
  /** Есть ли вложенные страницы. По нему рисуется значок раскрытия: без него
   *  он стоит у каждой строки, и половина раскрывается в пустоту. */
  hasChildren?: boolean;
  /** База, а не обычная страница. Открывается таблицей, а не редактором. */
  isBase?: boolean;
  canEdit?: boolean;
  restricted?: boolean;
};

export type PageBody = PageSummary & {
  content: unknown;
  canEdit?: boolean;
  restricted?: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export type Crumb = { id: string; slugId: string; title: string | null; icon: string | null };

/** Ветвь дерева. Пустой родитель означает корень пространства. */
export function pageTree(
  spaceId: string,
  parentPageId: string | null,
  fetcher?: typeof fetch,
  headers?: Record<string, string>
) {
  return post<PageSummary[]>('/api/pages/tree', { spaceId, parentPageId }, { fetcher, headers });
}

export function pageInfo(pageId: string, fetcher?: typeof fetch, headers?: Record<string, string>) {
  return post<PageBody>('/api/pages/info', { pageId }, { fetcher, headers });
}

export function breadcrumbs(
  pageId: string,
  fetcher?: typeof fetch,
  headers?: Record<string, string>
) {
  return post<Crumb[]>('/api/pages/breadcrumbs', { pageId }, { fetcher, headers });
}

export function createPage(
  values: { spaceId: string; title?: string; parentPageId?: string | null },
  fetcher?: typeof fetch
) {
  return post<{ id: string; slugId: string; title: string | null }>('/api/pages/create', values, {
    fetcher
  });
}

/**
 * Изменить страницу.
 *
 * Содержимое здесь не передаётся: его правит совместное редактирование, и
 * отправка тела обычным запросом затирала бы правки, которых этот экран не
 * видел. Через этот путь идут только название и значок.
 */
export function updatePage(
  values: { pageId: string; title?: string; icon?: string },
  fetcher?: typeof fetch
) {
  return post<PageBody>('/api/pages/update', values, { fetcher });
}

/**
 * Убрать страницу в корзину либо удалить насовсем.
 *
 * Один маршрут на оба действия: предмет тот же, разница в необратимости.
 * Удалять насовсем вправе распорядитель пространства — сервер это проверяет.
 */
export function deletePage(pageId: string, permanently = false, fetcher?: typeof fetch) {
  return post<{ status: string }>(
    '/api/pages/delete',
    { pageId, permanentlyDelete: permanently },
    { fetcher }
  );
}

/**
 * Переставить страницу в дереве.
 *
 * `position` это дробный ключ порядка между соседями: сервер считает его сам,
 * когда его не передали. `detach` выносит страницу в корень — отдельным
 * признаком, а не пустым родителем: пустое значение и «поле не передавали»
 * иначе неразличимы, и вынести страницу из вложенности было бы нельзя.
 */
export function movePage(
  values: { pageId: string; position?: string; parentPageId?: string | null; detach?: boolean },
  fetcher?: typeof fetch
) {
  return post<{ id: string; position: string | null; parentPageId: string | null }>(
    '/api/pages/move',
    values,
    { fetcher }
  );
}

/** Перенести страницу вместе с ветвью в другое пространство. */
export function movePageToSpace(pageId: string, spaceId: string, fetcher?: typeof fetch) {
  return post<{ id: string; spaceId: string }>(
    '/api/pages/move-to-space',
    { pageId, spaceId },
    { fetcher }
  );
}

/** Скопировать страницу с ветвью. Без пространства копия ложится рядом. */
export function duplicatePage(pageId: string, spaceId?: string, fetcher?: typeof fetch) {
  return post<{ id: string; slugId: string; title: string | null }>(
    '/api/pages/duplicate',
    { pageId, spaceId },
    { fetcher }
  );
}

export type WatchStatus = { isWatching: boolean; isMuted: boolean };

/**
 * Подписка на страницу.
 *
 * Подписаться может тот, кто страницу видит; отписаться — кто угодно, даже
 * потеряв доступ. Иначе отобранный доступ навсегда оставлял бы человека в
 * получателях извещений.
 */
export function watchPage(pageId: string, fetcher?: typeof fetch) {
  return post<WatchStatus>('/api/pages/watch', { pageId }, { fetcher });
}

export function unwatchPage(pageId: string, fetcher?: typeof fetch) {
  return post<WatchStatus>('/api/pages/unwatch', { pageId }, { fetcher });
}

export function watchStatus(
  pageId: string,
  fetcher?: typeof fetch,
  headers?: Record<string, string>
) {
  return post<WatchStatus>('/api/pages/watch-status', { pageId }, { fetcher, headers });
}

export type TrashedPage = PageSummary & { deletedAt: string; deletedById: string | null };

/**
 * Что лежит в корзине пространства.
 *
 * Пространство обязательно: общая корзина рабочего пространства перечисляла бы
 * названия страниц из тех пространств, куда человек не входит.
 */
export function trashedPages(
  spaceId: string,
  fetcher?: typeof fetch,
  headers?: Record<string, string>
) {
  return post<TrashedPage[]>('/api/pages/trash', { spaceId }, { fetcher, headers });
}

export function restorePage(pageId: string, fetcher?: typeof fetch) {
  return post<{ status: string }>('/api/pages/restore', { pageId }, { fetcher });
}

/**
 * Строка перечня страниц: название, адрес и пространство.
 *
 * Отдельный вид, а не `PageSummary`: тому пространство приходит
 * идентификатором, а перечню нужно и короткое имя для ссылки, и название для
 * показа — иначе экрану пришлось бы искать их по всем пространствам.
 */
export type PageListing = {
  id: string;
  slugId: string;
  title: string | null;
  icon: string | null;
  spaceId: string;
  spaceSlug: string;
  spaceName: string | null;
  updatedAt: string | null;
  createdAt: string | null;
  /** База, а не обычная страница: у неё свой значок и свой экран. */
  isBase?: boolean;
};

/** Что правили последним. Без пространства — по всем доступным. */
export function recentPages(
  spaceId?: string | null,
  fetcher?: typeof fetch,
  headers?: Record<string, string>
) {
  return post<PageListing[]>(
    '/api/pages/recent',
    { spaceId: spaceId || undefined },
    { fetcher, headers }
  );
}

/**
 * Что человек завёл сам. Без идентификатора — спрашивающий.
 *
 * Пространство отбирает сервер: предел в полсотни строк берётся до отбора, и
 * отсев на стороне клиента показывал бы пустой перечень там, где страницы
 * есть, — просто не попали в первую полусотню.
 */
export function pagesCreatedBy(
  userId?: string | null,
  spaceId?: string | null,
  fetcher?: typeof fetch,
  headers?: Record<string, string>
) {
  return post<PageListing[]>(
    '/api/pages/created-by-user',
    { userId: userId || undefined, spaceId: spaceId || undefined },
    { fetcher, headers }
  );
}
