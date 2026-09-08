/**
 * Канал событий.
 *
 * Одно соединение на вкладку, а не на экран: сервер заводит его в комнаты при
 * подключении, и второе соединение означало бы второй набор комнат и вдвое
 * больше работы на каждую рассылку.
 *
 * Подписка не выбирает событий: сервер шлёт всё, что положено этому человеку,
 * а разбирают их сами экраны. Обратное — подписка по видам — потребовала бы
 * второго перечня видов на клиенте, и он разошёлся бы с серверным.
 *
 * Учётными данными служит кука входа: рукопожатие идёт тем же источником, что
 * и страница, и подставляет её само. Токен в запросе не нужен и опасен — он
 * виден в журналах посредников.
 */

import { apiBase } from '$lib/api/base';

/**
 * Канал открывается только в браузере.
 *
 * Проверяется наличие окна, а не признак сборки: этот модуль зовут и из
 * отображений узлов редактора, которые собираются отдельно от приложения, и
 * там признак сборки читается не тем экземпляром.
 */
const inBrowser = typeof window !== 'undefined';

/** Событие канала: вид действия и всё, что к нему приложено. */
export type RealtimeEvent = { operation?: string; [key: string]: unknown };

type Listener = (event: RealtimeEvent) => void;

type Connection = {
  on: (name: string, handler: (data: unknown) => void) => void;
  emit: (name: string, data: unknown) => void;
  disconnect: () => void;
  connected: boolean;
};

let socket: Connection | null = null;
let connecting: Promise<Connection | null> | null = null;
const listeners = new Set<Listener>();

/** Имена событий сервера. Совпадают с v1: канал общий на обе версии. */
const MESSAGE = 'message';
const NOTIFICATION = 'notification';

async function connect(): Promise<Connection | null> {
  if (socket) return socket;
  if (connecting) return connecting;

  connecting = (async () => {
    try {
      // Библиотека грузится по требованию: на страницах без канала — вход,
      // страница по ссылке — она не нужна вовсе.
      const { io } = await import('socket.io-client');
      const made = io(apiBase() || undefined, {
        path: '/socket.io',
        // Кука входа подставляется браузером сама, но только при явном
        // разрешении: без него рукопожатие уходит без неё и отвергается.
        withCredentials: true,
        transports: ['websocket', 'polling']
      }) as unknown as Connection;

      // Отказ рукопожатия называется вслух. Он молчалив по своей природе:
      // библиотека просто пробует снова, и канал выглядит работающим, пока
      // кто-нибудь не заметит, что события не приходят. Так и вышло при
      // осмотре — сервер отвергал соединение из-за расхождения APP_URL с
      // адресом, по которому открыто приложение.
      made.on('connect_error', (error: unknown) => {
        console.error('Канал событий отказал в подключении', error);
      });

      for (const name of [MESSAGE, NOTIFICATION]) {
        made.on(name, (data: unknown) => {
          const event = (data ?? {}) as RealtimeEvent;
          // Уведомления приходят своим именем и вида в теле не несут: он
          // подставляется здесь, чтобы у слушателей было одно правило разбора.
          const filled = name === NOTIFICATION ? { operation: NOTIFICATION, ...event } : event;
          for (const listener of [...listeners]) listener(filled);
        });
      }

      socket = made;
      return made;
    } catch (error) {
      // Отказ канала не должен ронять экран: без него страница работает, просто
      // не обновляется сама.
      console.error('Канал событий не открылся', error);
      return null;
    } finally {
      connecting = null;
    }
  })();

  return connecting;
}

/**
 * Слушать события канала.
 *
 * Возвращает отписку. Соединение закрывается, когда уходит последний
 * слушатель: держать его открытым ради никого незачем, а переподключение при
 * следующем экране стоит одного рукопожатия.
 */
export function onRealtime(listener: Listener): () => void {
  if (!inBrowser) return () => {};

  listeners.add(listener);
  void connect();

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && socket) {
      socket.disconnect();
      socket = null;
    }
  };
}

/** Отправить управляющее сообщение: подписка на базу и отписка от неё. */
export async function sendRealtime(payload: RealtimeEvent): Promise<void> {
  if (!inBrowser) return;
  const made = await connect();
  made?.emit(MESSAGE, payload);
}
