/**
 * Одновременная правка одной страницы несколькими соединениями.
 *
 * Зачем. Совместное редактирование проверялось двумя вкладками, а вопрос был
 * про десяток: сходятся ли правки, доезжает ли результат до базы и остаётся ли
 * сервис жив. Глазами это не проверить — десять вкладок руками не набрать
 * одновременно, а расхождение проявляется именно в одновременности.
 *
 * Что делает. Открывает N соединений к каналу правки стенда тем же
 * протоколом, что и браузер (`@hocuspocus/provider`), и каждое добавляет свои
 * абзацы очередями, без пауз между соединениями. Потом сверяет три вещи:
 *
 * 1. все соединения видят один и тот же документ (расхождение означало бы
 *    потерянную правку);
 * 2. в документе ровно столько добавленных абзацев, сколько отправлено (ни
 *    одна правка не потерялась при слиянии);
 * 3. после разрыва и паузы на сохранение то же самое лежит в базе — то есть
 *    сосед записал слитый документ, а не последний увиденный.
 *
 * Чего не проверяет. Все соединения идут от одной учётной записи: заводить
 * записи на стенде нельзя, и десять разных людей здесь не изобразить.
 * Отличается от настоящих десяти человек двумя вещами — подписями в перечне
 * присутствующих и числом проверок прав в обходе сервиса. Само слияние правок
 * от числа учётных записей не зависит.
 *
 * Запуск с машины, где поднят стенд:
 *
 *     docker cp scripts/stand-session.py tessera-v2-api:/tmp/stand-session.py
 *     docker exec tessera-v2-api python /tmp/stand-session.py > /tmp/token
 *     TESSERA_TOKEN=$(cat /tmp/token) node scripts/collab-load.mjs <slugId>
 *
 * Переменные: `TESSERA_URL` (умолчание `http://localhost:8080`),
 * `CLIENTS` (10), `ROUNDS` (5), `HOLD_MS` (0 — держать соединения открытыми
 * после правок, чтобы посмотреть перечень присутствующих глазами).
 */

import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';

const BASE = process.env.TESSERA_URL || 'http://localhost:8080';
const TOKEN = process.env.TESSERA_TOKEN;
const CLIENTS = Number(process.env.CLIENTS || 10);
const ROUNDS = Number(process.env.ROUNDS || 5);
const HOLD_MS = Number(process.env.HOLD_MS || 0);

/** Сколько ждать сохранения у соседа. Его порог — десять секунд. */
const SAVE_WAIT_MS = 20000;

const slug = process.argv[2];

if (!TOKEN || !slug) {
  console.error('нужны TESSERA_TOKEN и короткое имя страницы доводом');
  process.exit(1);
}

/** Обращение к приложению от имени открытого сеанса. */
async function api(path, body) {
  const answer = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body ?? {})
  });
  if (!answer.ok) throw new Error(`${path}: ${answer.status} ${await answer.text()}`);
  return answer.json();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Текст документа без разметки: по нему сверяются соединения между собой. */
function shape(document_) {
  return document_.getXmlFragment('default').toString();
}

/** Сколько абзацев этого прогона уже в документе. */
function marked(text, mark) {
  return text.split(mark).length - 1;
}

const page = await api('/api/pages/info', { pageId: slug });
console.log(`страница: ${page.title} (${page.id})`);

const name = `page.${page.id}`;
const mark = `нагрузка-${Date.now()}`;

const clients = [];
const synced = [];
for (let index = 0; index < CLIENTS; index += 1) {
  const { token } = await api('/api/auth/collab-token');
  const document_ = new Y.Doc();
  // Сокет свой у каждого соединения: провайдер заводит его сам, когда готовый
  // не передан. Один на всех сложил бы десять соединений в одно.
  synced.push(
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`соединение ${index} не доехало`)),
        30000
      );
      const provider = new HocuspocusProvider({
        url: `${BASE.replace(/^http/, 'ws')}/collab`,
        name,
        document: document_,
        token,
        onSynced: () => {
          clearTimeout(timer);
          resolve();
        },
        onAuthenticationFailed: ({ reason }) => {
          clearTimeout(timer);
          reject(new Error(`соединение ${index}: ${reason}`));
        }
      });
      // Соединение объявляет себя в awareness так же, как это делает
      // браузер: оттуда берутся и чужие курсоры, и перечень присутствующих.
      // Без этого проход был бы не виден ни там, ни там.
      provider.setAwarenessField('user', {
        id: `нагрузка-${index}`,
        name: `Соединение ${index}`,
        color: `hsl(${(index * 47) % 360} 70% 55%)`,
        avatarUrl: null
      });
      clients.push({ index, provider, document: document_ });
    })
  );
}

await Promise.all(synced);
console.log(`подключено соединений: ${clients.length}`);

const before = marked(shape(clients[0].document), mark);

for (let round = 0; round < ROUNDS; round += 1) {
  // Без пауз между соединениями: расхождение проявляется именно в
  // одновременности, а по очереди сходится и сломанное слияние.
  for (const one of clients) {
    const paragraph = new Y.XmlElement('paragraph');
    paragraph.insert(0, [new Y.XmlText(`${mark} соединение ${one.index} круг ${round}`)]);
    one.document.getXmlFragment('default').push([paragraph]);
  }
  await sleep(100);
}

const expected = before + CLIENTS * ROUNDS;
await sleep(3000);

const shapes = clients.map((one) => shape(one.document));
const same = new Set(shapes).size === 1;
const counted = marked(shapes[0], mark);

console.log(`отправлено абзацев: ${CLIENTS * ROUNDS}`);
console.log(`видно у соединений: ${counted} (ожидалось ${expected})`);
console.log(`документы совпадают: ${same ? 'да' : 'НЕТ'}`);

if (!same) {
  const sizes = shapes.map((one) => one.length);
  console.log(`длины документов: ${sizes.join(', ')}`);
}

if (HOLD_MS > 0) {
  console.log(`держим соединения ${HOLD_MS / 1000} с...`);
  await sleep(HOLD_MS);
}

for (const one of clients) {
  one.provider.destroy();
}

console.log(`ждём сохранения ${SAVE_WAIT_MS / 1000} с...`);
await sleep(SAVE_WAIT_MS);

const stored = await api('/api/pages/info', { pageId: slug });
const storedText = JSON.stringify(stored.content);
const inDatabase = marked(storedText, mark);
console.log(`в базе абзацев прогона: ${inDatabase}`);

const verdict = same && counted === expected && inDatabase === CLIENTS * ROUNDS;
console.log(verdict ? 'ИТОГ: сходится' : 'ИТОГ: расхождение');
process.exit(verdict ? 0 : 1);
