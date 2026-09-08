import { post } from '$lib/api/client';

/**
 * Токен для сеанса совместного редактирования.
 *
 * Отдельный вид токена, короткоживущий: сервис редактирования держит соединение
 * сам и в базу за проверкой не ходит, поэтому токен доступа туда отдавать
 * нельзя — он дал бы этому процессу право ходить в приложение от имени
 * человека.
 */
export function collabToken(fetcher?: typeof fetch) {
  return post<{ token: string }>('/api/auth/collab-token', {}, { fetcher });
}

/**
 * Адрес канала редактирования.
 *
 * Тот же путь, что в v1: `/collab` на том же происхождении, что и страница.
 * Схема выводится из адреса страницы, иначе за обратным прокси с TLS браузер
 * откажется открывать незащищённое соединение.
 */
export function collabAddress(): string {
  const secure = window.location.protocol === 'https:';
  return `${secure ? 'wss' : 'ws'}://${window.location.host}/collab`;
}

/** Имя документа. Совпадает с тем, что разбирает сервис: `page.<id>`. */
export function documentName(pageId: string): string {
  return `page.${pageId}`;
}

/** Служебные сообщения канала. Те же имена, что шлёт `services/collab`. */
export const DOCUMENT_UNREADABLE = 'document.unreadable';
export const ACCESS_REVOKED = 'access.revoked';
export const ACCESS_CHANGED = 'access.changed';

/** Что видно про канал: подключаемся, работаем, связь потеряна. */
export type CollabStatus = 'connecting' | 'ready' | 'offline';

/**
 * Состояние канала после сообщения библиотеки.
 *
 * «Подключение» после разрыва — это по-прежнему разрыв. Библиотека повторяет
 * попытки и о каждой сообщает `connecting`; принимая это за начальную загрузку,
 * экран затирал бы сообщение о потерянной связи словом «загрузка», и человек
 * читал бы обрыв как незаконченное открытие страницы.
 *
 * Из разрыва выводит только состоявшееся подключение.
 */
export function nextStatus(current: CollabStatus, reported: string): CollabStatus {
  if (reported === 'connected') return 'ready';
  if (current === 'offline') return 'offline';
  return 'connecting';
}

/**
 * Что делать с телом страницы, когда пришло состояние документа.
 *
 * `wait` — источник пока один. Документ приходит из двух мест: с сервера и из
 * хранилища браузера, где лежит набранное без связи. Решение по одному из них
 * пришлось бы на миг, когда второе ещё не применено: документ выглядит пустым,
 * засев проходит, а следом прилетает то же самое — и страница показывает своё
 * содержимое дважды. Ожидание хранилища при этом ограничено по времени: не
 * ответить оно может и вовсе.
 *
 * `seed` — документ пуст, а тело у страницы есть: подключившийся первым обязан
 * его положить, иначе пустой документ означал бы, что страница потеряла текст.
 *
 * `skip` — класть нечего: тело уже в документе либо его нет вовсе.
 */
export function seedDecision(state: {
  fromServer: boolean;
  fromBrowser: boolean;
  empty: boolean;
  content: unknown;
}): 'wait' | 'seed' | 'skip' {
  if (!state.fromServer || !state.fromBrowser) return 'wait';
  return state.empty && state.content ? 'seed' : 'skip';
}

/**
 * Плоский текст документа.
 *
 * Запасной показ для тела, которое схема этой версии не разбирает: узла нет, а
 * слова есть, и показать их лучше, чем пустой лист. Разметка при этом теряется
 * намеренно — восстанавливать её нечем, а вид «как будто всё на месте» ввёл бы
 * в заблуждение.
 */
export function plainText(content: unknown): string[] {
  const lines: string[] = [];

  const walk = (node: unknown, into: string[]): void => {
    if (Array.isArray(node)) {
      for (const one of node) walk(one, into);
      return;
    }
    if (!node || typeof node !== 'object') return;

    const shape = node as { type?: string; text?: string; content?: unknown };
    if (typeof shape.text === 'string') {
      into.push(shape.text);
      return;
    }
    if (shape.content === undefined) return;

    // Узлы верхнего уровня становятся отдельными строками: без этого весь
    // документ слипается в один абзац.
    const own: string[] = [];
    walk(shape.content, own);
    const joined = own.join('').trim();
    if (joined) into.push(joined);
  };

  const collected: string[] = [];
  const root = content as { content?: unknown } | null;
  walk(root?.content ?? content, collected);
  for (const one of collected) {
    const clean = one.trim();
    if (clean) lines.push(clean);
  }
  return lines;
}
