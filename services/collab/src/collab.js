/**
 * Канал совместного редактирования.
 *
 * Протокол Hocuspocus поверх Yjs, путь `/collab`, имя документа `page.<id>` —
 * всё как в v1: клиент не переписывается, он подключается к другому процессу по
 * тому же протоколу.
 *
 * Здесь живёт состояние документа и схема узлов редактора. Права и запись в
 * базу живут на стороне Python, и каждый вопрос о них уходит туда. Разделение
 * не вкусовое: схема узлов описана расширениями Tiptap, и второе её описание
 * теряет узлы молча, а права, описанные дважды, расходятся.
 */

import { createRequire } from 'node:module';

import { WebSocketServer } from 'ws';

import { authorize, loadDocument, rights, storeDocument } from './backend.js';
import { tiptapExtensions } from './extensions.js';

const require = createRequire(import.meta.url);

const { Hocuspocus } = require('@hocuspocus/server');
const { TiptapTransformer } = require('@hocuspocus/transformer');
const { generateText } = require('@tiptap/core');
const Y = require('yjs');

/** Имя поля документа в Yjs. Общее с v1 и с клиентом. */
const FIELD = 'default';

/** Имя документа: `page.<идентификатор страницы>`. */
const DOCUMENT_PREFIX = 'page.';

/**
 * Через сколько после последней правки сохранять и как долго можно
 * откладывать. Значения из v1: чаще — очередь ожидающих транзакций на одной
 * строке, реже — шире окно потери правок при падении процесса.
 */
const DEBOUNCE_MS = Number(process.env.COLLAB_DEBOUNCE_MS || 10000);
const MAX_DEBOUNCE_MS = Number(process.env.COLLAB_MAX_DEBOUNCE_MS || 45000);

/**
 * Как часто перепроверяются права у уже открытых соединений.
 *
 * Подключение проверяется один раз, а сеанс длится часами. Без обхода человек,
 * которого убрали из пространства, дописывает открытый документ до тех пор,
 * пока сам не закроет вкладку.
 */
const SWEEP_INTERVAL_MS = Number(process.env.COLLAB_SWEEP_INTERVAL_MS || 30000);

/** Служебные сообщения канала. Клиент разбирает их в `onStateless`. */
export const ACCESS_REVOKED = 'access.revoked';
export const ACCESS_CHANGED = 'access.changed';
export const DOCUMENT_UNREADABLE = 'document.unreadable';

/** Код закрытия соединения при отзыве доступа. Тот же, что в v1. */
const FORBIDDEN = { code: 4403, reason: 'Forbidden' };

export function pageIdOf(documentName) {
  if (typeof documentName !== 'string' || !documentName.startsWith(DOCUMENT_PREFIX)) {
    return null;
  }
  return documentName.slice(DOCUMENT_PREFIX.length) || null;
}

/**
 * Плоский текст документа.
 *
 * Считается здесь, а не на стороне Python: он выводится из той же схемы узлов,
 * и второй его расчёт разошёлся бы с первым ровно на тех узлах, ради которых
 * сервис и выделен. Пустая строка при отказе разбора — не потеря: поиск по
 * тексту восстановится следующим сохранением.
 */
export function textOf(json) {
  try {
    return generateText(json, tiptapExtensions);
  } catch {
    return '';
  }
}

/**
 * Кто правил документ с прошлого сохранения.
 *
 * Список нужен серверной половине: правивший становится подписчиком страницы, и
 * из этих же людей складывается лента обновлений. Хранится по имени документа
 * и очищается вместе с сохранением: иначе один и тот же человек попадал бы в
 * каждое следующее сохранение до выгрузки документа из памяти.
 */
class Contributors {
  constructor() {
    this.byDocument = new Map();
  }

  add(documentName, userId) {
    if (!userId) return;
    let known = this.byDocument.get(documentName);
    if (!known) {
      known = new Set();
      this.byDocument.set(documentName, known);
    }
    known.add(userId);
  }

  consume(documentName) {
    const known = this.byDocument.get(documentName);
    if (!known) return [];
    this.byDocument.delete(documentName);
    return [...known];
  }

  forget(documentName) {
    this.byDocument.delete(documentName);
  }
}

function log(message) {
  console.log(`[collab] ${message}`);
}

/**
 * Отзыв доступа у одного соединения.
 *
 * Сообщение уходит до закрытия: `close` шлёт клиенту только строку причины, и
 * отличить отзыв прав от обычного разрыва по нему нельзя. Без явного сообщения
 * редактор на экране остаётся редактируемым, и набранное уходит в локальный
 * документ, то есть в никуда.
 */
function revoke(connection, documentName, reason) {
  try {
    connection.sendStateless(JSON.stringify({ type: ACCESS_REVOKED, reason }));
  } catch {
    // Сокет мог закрыться между обходом и отправкой, это не ошибка.
  }
  try {
    connection.close(FORBIDDEN);
  } catch {
    // То же самое.
  }
  log(`соединение отключено от ${documentName}: ${reason}`);
}

/**
 * Понижение до чтения и возврат права записи.
 *
 * Значение вычисляется заново каждый проход, а не только понижается:
 * восстановленное право обязано возвращаться без переподключения.
 */
function applyReadOnly(connection, readOnly, documentName) {
  if (connection.readOnly === readOnly) return;
  connection.readOnly = readOnly;
  try {
    connection.sendStateless(JSON.stringify({ type: ACCESS_CHANGED, canEdit: !readOnly }));
  } catch {
    // См. `revoke`.
  }
  log(`${documentName}: соединение переведено в режим ${readOnly ? 'чтения' : 'правки'}`);
}

export function createCollabServer() {
  const contributors = new Contributors();

  /**
   * Документы, которые не удалось разобрать, и причина по каждому.
   *
   * Такое случается, когда в теле встречается узел, которого нет в схеме
   * редактора: после ввоза из чужой системы и после отката версии приложения.
   * Запись здесь делает две вещи: запрещает сохранение — пустой документ в
   * памяти стёр бы страницу целиком — и даёт причину подключившемуся, вместо
   * пустого листа без единого слова.
   */
  const unreadable = new Map();

  const hocuspocus = new Hocuspocus({
    debounce: DEBOUNCE_MS,
    maxDebounce: MAX_DEBOUNCE_MS,
    // Свой лог вместо стандартного: тот пишет каждое подключение построчно и
    // на десятке вкладок превращает журнал в поток.
    quiet: true,

    async onAuthenticate({ documentName, token, connectionConfig, requestParameters }) {
      // Имя документа приходит дважды: доводом адреса и первым сообщением
      // протокола. Прокси закрепляет соединение за репликой по адресу —
      // сообщений он не разбирает, — а документ открывается по сообщению.
      // Разойдясь, они привели бы соединение на реплику, где документ не
      // живёт, и правки двух реплик по одному документу не сошлись бы молча.
      // Поэтому расхождение, как и отсутствие довода, это отказ.
      if (requestParameters?.get('documentName') !== documentName) {
        log(`${documentName}: имя в адресе подключения не совпало с именем документа`);
        throw new Error('document name mismatch');
      }
      const answer = await authorize(token, documentName);
      if (!answer?.canEdit) {
        connectionConfig.readOnly = true;
      }
      return { user: answer.user, pageId: answer.pageId };
    },

    async onLoadDocument({ documentName }) {
      const pageId = pageIdOf(documentName);
      if (!pageId) return new Y.Doc();

      const answer = await loadDocument(pageId);

      if (answer?.ydoc) {
        // Двоичное состояние первым: в нём есть история правок, которой в JSON
        // нет, и восстановление из JSON теряет незавершённые правки открытых
        // вкладок.
        const document = new Y.Doc();
        Y.applyUpdate(document, new Uint8Array(Buffer.from(answer.ydoc, 'base64')));
        return document;
      }

      if (answer?.content) {
        try {
          const document = TiptapTransformer.toYdoc(answer.content, FIELD, tiptapExtensions);
          // Разобрался: прежняя отметка о неразобранном снимается. Иначе
          // страница, починенная правкой тела, оставалась бы запертой до
          // перезапуска процесса.
          unreadable.delete(documentName);
          return document;
        } catch (error) {
          const reason = String(error?.message || error);
          unreadable.set(documentName, reason);
          log(`${documentName}: тело не разобрано, ${reason}`);
          // Пустой документ, а не отказ подключения: отказ клиент читает как
          // обрыв связи и переподключается без конца. Содержимое при этом не
          // теряется — сохранение для такого документа запрещено ниже.
          return new Y.Doc();
        }
      }

      unreadable.delete(documentName);
      return new Y.Doc();
    },

    /**
     * Сообщить подключившемуся, что тело страницы не разобрано.
     *
     * Каждому соединению отдельно, а не рассылкой по документу: подключаются
     * в разное время, а рассылка дошла бы только до тех, кто уже был.
     */
    async connected({ documentName, connection }) {
      const reason = unreadable.get(documentName);
      if (!reason) return;
      try {
        connection.sendStateless(JSON.stringify({ type: DOCUMENT_UNREADABLE, reason }));
      } catch {
        // См. `revoke`: соединение могло закрыться, пока шёл ответ.
      }
    },

    async onStoreDocument({ documentName, document, context }) {
      const pageId = pageIdOf(documentName);
      if (!pageId) return;

      if (unreadable.has(documentName)) {
        // Тело не разобралось, и документ в памяти пуст. Запись стёрла бы
        // страницу целиком — ровно то содержимое, из-за которого разбор и не
        // прошёл. Правки здесь не теряются: править нечего, документ пуст.
        log(`${documentName}: сохранение пропущено, тело не разобрано`);
        return;
      }

      const json = TiptapTransformer.fromYdoc(document, FIELD);
      const state = Buffer.from(Y.encodeStateAsUpdate(document)).toString('base64');
      const editors = contributors.consume(documentName);

      let answer;
      try {
        answer = await storeDocument({
          pageId,
          userId: context?.user?.id,
          content: json,
          text: textOf(json),
          ydoc: state,
          contributors: editors,
        });
      } catch (error) {
        // Правившие возвращаются в список: иначе они пропадут из подписчиков
        // страницы, а повторить сохранение будет уже некому.
        for (const one of editors) contributors.add(documentName, one);
        throw error;
      }

      if (answer?.saved) {
        document.broadcastStateless(
          JSON.stringify({
            type: 'page.updated',
            updatedAt: answer.updatedAt,
            lastUpdatedById: context?.user?.id,
            lastUpdatedBy: context?.user,
          }),
        );
      }
    },

    async onChange({ documentName, context }) {
      contributors.add(documentName, context?.user?.id);
    },

    async afterUnloadDocument({ documentName }) {
      contributors.forget(documentName);
      // Отметка о неразобранном снимается вместе с документом: при следующем
      // открытии тело читается заново, и оно могло измениться.
      unreadable.delete(documentName);
    },
  });

  return { hocuspocus, contributors };
}

/**
 * Один проход перепроверки прав.
 *
 * Одна проверка на человека, а не на соединение: у одного человека бывает
 * несколько вкладок с одной страницей, и спрашивать права на каждую значит
 * умножать запросы к базе на число вкладок.
 */
export async function sweepOnce(hocuspocus) {
  for (const document of hocuspocus.documents.values()) {
    const connections = document.getConnections();
    if (connections.length === 0) continue;

    const byUser = new Map();
    for (const connection of connections) {
      const userId = connection.context?.user?.id;
      if (!userId) {
        // Контекст ставит `onAuthenticate`, и соединения без него быть не
        // может. Если оно появилось, проверить права неизвестно кому нельзя, а
        // оставить непроверенным нельзя тем более.
        revoke(connection, document.name, 'соединение без пользователя');
        continue;
      }
      const known = byUser.get(userId);
      if (known) known.push(connection);
      else byUser.set(userId, [connection]);
    }

    if (byUser.size === 0) continue;

    let answer;
    try {
      answer = await rights(document.name, [...byUser.keys()]);
    } catch (error) {
      // Недоступная серверная половина не повод отбирать доступ: это временный
      // отказ, а отзыв выкидывает человека из документа с потерей набранного.
      log(`права по ${document.name} не проверены: ${error?.message || error}`);
      continue;
    }

    if (answer?.gone) {
      for (const connection of connections) {
        revoke(connection, document.name, 'страница не найдена');
      }
      continue;
    }

    for (const [userId, userConnections] of byUser) {
      const verdict = answer?.users?.[userId];
      if (!verdict || !verdict.allowed) {
        for (const connection of userConnections) {
          revoke(connection, document.name, 'доступ к странице отозван');
        }
        continue;
      }
      for (const connection of userConnections) {
        applyReadOnly(connection, !verdict.canEdit, document.name);
      }
    }
  }
}

/** Таймер перепроверки. Проходы не накладываются: медленная база растянула бы обход. */
export function startSweep(hocuspocus, intervalMs = SWEEP_INTERVAL_MS) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await sweepOnce(hocuspocus);
    } catch (error) {
      log(`обход прав прерван: ${error?.message || error}`);
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * Остановка канала: дождаться выгрузки документов и закрыть соединения.
 *
 * Просто закрыть сокеты нельзя: у Hocuspocus сохранение отложено, и разрыв
 * соединения до выгрузки документа теряет последние правки. Поэтому сначала
 * закрываются соединения, а ожидание идёт до того момента, когда в памяти не
 * осталось ни одного документа.
 */
export function closeCollab(hocuspocus, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    if (hocuspocus.getDocumentsCount() === 0) {
      resolve();
      return;
    }

    // Предел ожидания обязателен: документ, чьё сохранение не проходит,
    // подвесил бы остановку процесса навсегда.
    const guard = setTimeout(resolve, timeoutMs);
    hocuspocus.configuration.extensions.push({
      async afterUnloadDocument({ instance }) {
        if (instance.getDocumentsCount() === 0) {
          clearTimeout(guard);
          resolve();
        }
      },
    });
    hocuspocus.closeConnections();
  });
}

/**
 * Приём подключений на путь `/collab`.
 *
 * Апгрейд перехватывается вручную: на том же порту работает HTTP для
 * преобразования содержимого, и отдавать ему сокеты нельзя, как и наоборот.
 */
export function attachCollab(httpServer, hocuspocus) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    let pathname;
    try {
      pathname = new URL(request.url, `ws://${request.headers.host || 'localhost'}/`).pathname;
    } catch {
      socket.destroy();
      return;
    }

    if (pathname !== '/collab') {
      // Чужой путь закрывается сразу: висящий сокет на неизвестном пути
      // занимает соединение и не даёт ни ответа, ни отказа.
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (websocket) => {
      hocuspocus.handleConnection(websocket, request);
    });
  });

  return wss;
}
