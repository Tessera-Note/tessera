/**
 * Преобразование содержимого страниц.
 *
 * Отдельный сервис на Node, потому что схема узлов редактора описана
 * расширениями Tiptap на TypeScript и другой реализации у неё быть не должно.
 * Второе описание той же схемы — это класс ошибок, который не проявляется
 * отказом: документ сохраняется, а узел, которого нет во второй схеме, молча
 * выбрасывается при следующем разборе.
 *
 * Зависимости объявлены в корне монорепозитория и не дублируются здесь: файл
 * блокировки принадлежит пакетному менеджеру, и добавление сюда своего
 * `package.json` с зависимостями заставило бы его перегенерировать.
 *
 * Сервис не знает ни о базе, ни о правах. Он получает документ и отдаёт
 * документ; всё, что касается доступа, решено до обращения сюда.
 */
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { attachCollab, closeCollab, createCollabServer, startSweep } from './collab.js';
import { docxFromJson } from './docx.js';

import {
  addUniqueIdsToDoc,
  htmlToMarkdown,
  markdownToHtml,
  tiptapExtensions,
} from './extensions.js';

const require = createRequire(import.meta.url);
// Серверная сборка: обычная требует браузерного окружения и отказывает прямым
// сообщением об этом.
const { generateHTML, generateJSON } = require('@tiptap/html/server');
const { generateText } = require('@tiptap/core');

const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || '0.0.0.0';

/** Предел размера тела. Документ страницы измеряется килобайтами; всё, что
 * заметно больше, — это ошибка вызывающего, а не большая страница. */
const MAX_BODY = 8 * 1024 * 1024;

function jsonFromHtml(html) {
  const document = generateJSON(html || '', tiptapExtensions);
  try {
    // Узлам проставляются устойчивые идентификаторы: по ним держатся
    // комментарии и якоря ссылок. Отказ здесь не повод потерять документ —
    // без идентификаторов он остаётся верным, просто якоря придётся
    // проставить заново.
    return addUniqueIdsToDoc(document, tiptapExtensions);
  } catch {
    return document;
  }
}

const handlers = {
  'markdown-to-json': async (body) => ({
    content: jsonFromHtml(await markdownToHtml(body.markdown || '')),
  }),
  'html-to-json': async (body) => ({ content: jsonFromHtml(body.html || '') }),
  'json-to-html': async (body) => ({
    html: generateHTML(body.content || emptyDocument(), tiptapExtensions),
  }),
  'json-to-markdown': async (body) => ({
    markdown: htmlToMarkdown(
      generateHTML(body.content || emptyDocument(), tiptapExtensions),
    ),
  }),
  'json-to-text': async (body) => ({
    text: generateText(body.content || emptyDocument(), tiptapExtensions),
  }),
  // Содержимое файла уходит в base64: ответ этого сервиса всегда JSON, а
  // двоичный ответ потребовал бы второго вида ответа ради одного маршрута.
  'json-to-docx': async (body) => ({
    docx: (await docxFromJson(body.content || emptyDocument(), body.images)).toString(
      'base64',
    ),
  }),
};

function emptyDocument() {
  return { type: 'doc', content: [] };
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) {
      throw new Error('body too large');
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function send(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

export function createTransformServer(stats = () => ({ connections: 0, documents: 0 })) {
  return createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      // Готовность проверяет оркестратор, у которого нет ни токена, ни
      // содержимого: ответ не несёт ничего, кроме признака жизни.
      send(response, 200, { status: 'ok' });
      return;
    }

    if (request.method === 'GET' && request.url === '/stats') {
      // Счётчики канала редактирования. Живут здесь, а не на серверной
      // половине: соединения и документы держит этот процесс, и спрашивать о
      // них соседа значило бы отвечать по памяти чужого процесса.
      send(response, 200, stats());
      return;
    }

    const name = (request.url || '').replace(/^\/transform\//, '').split('?')[0];
    const handler = handlers[name];
    if (request.method !== 'POST' || !handler) {
      send(response, 404, { error: 'unknown endpoint' });
      return;
    }

    try {
      const body = await readBody(request);
      send(response, 200, await handler(body));
    } catch (error) {
      // Разбор чужого документа отказывает на битом входе, и это обычный
      // исход, а не поломка сервиса: сообщение уходит вызывающему, процесс
      // продолжает работать.
      send(response, 400, { error: String(error?.message || error) });
    }
  });
}

// Сервер поднимается, только когда этот файл и есть точка входа. Прежде здесь
// стояла проверка `NODE_ENV !== 'test'`: она опирается на переменную, которую
// запуск проверок не выставляет, поэтому импорт файла в проверке занимал
// настоящий порт. На машине, где порт уже занят соседом, это роняло весь файл
// проверок ошибкой, к самим проверкам отношения не имеющей.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Канал совместного редактирования поднимается на том же порту: у него та же
  // схема узлов редактора и тот же процесс, а второй порт означал бы второй
  // сервис с тем же кодом внутри.
  const { hocuspocus } = createCollabServer();

  const server = createTransformServer(() => ({
    connections: hocuspocus.getConnectionsCount(),
    documents: hocuspocus.getDocumentsCount(),
  }));
  attachCollab(server, hocuspocus);
  const stopSweep = startSweep(hocuspocus);

  server.listen(PORT, HOST, () => {
    console.log(`Преобразование содержимого слушает ${HOST}:${PORT}`);
    console.log(`Совместное редактирование слушает ${HOST}:${PORT}/collab`);
  });

  const stop = async () => {
    // Порядок обратный запуску: сначала перестаём проверять права, потом
    // закрываем соединения, и только затем сам сервер. Иначе обход застаёт
    // уже закрытые соединения.
    stopSweep();
    try {
      await closeCollab(hocuspocus);
    } catch (error) {
      console.error(error);
    }
    server.close(() => process.exit(0));
  };

  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
