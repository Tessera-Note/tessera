/**
 * Кто стоит за упоминанием прямо сейчас.
 *
 * Подпись в узле упоминания заморожена на момент вставки. Без разрешения на
 * лету имя удалённого оставалось бы в теле каждой страницы, где его упомянули:
 * обезличивание при удалении до содержимого не доходит, а переписывать
 * страницы ради переименования нельзя — их правит человек, и правка сервером
 * затирала бы чужие изменения.
 *
 * Запросы собираются в пачку. Упоминаний на странице бывает десятки, и запрос
 * на каждое означал бы десятки обращений при каждом открытии; сбор в один
 * оборот цикла сводит их к одному.
 */

import { post } from '$lib/api/client';

export type MentionTarget = {
  id: string;
  name: string | null;
  deactivated: boolean;
};

/** Сырой запрос. Отдельно от кеша: проверяется он же, но без времени и пачек. */
export function resolveMentions(userIds: string[], fetcher?: typeof fetch) {
  return post<MentionTarget[]>('/api/users/mentions', { userIds }, { fetcher });
}

/**
 * Ответ живёт долго: имя меняется редко, а упоминаний одного и того же
 * человека на странице бывает много. Срок из v1.
 */
const FRESH_MS = 5 * 60 * 1000;

/** Известное: `null` означает «сервер ответил, и такого нет». */
type Known = { target: MentionTarget | null; at: number };

const known = new Map<string, Known>();

/** Кто ждёт ответа по этому человеку. Пока пачка не ушла, сюда же и попадают. */
const waiting = new Map<
  string,
  Array<{ done: (target: MentionTarget | null) => void; fail: (error: unknown) => void }>
>();

let scheduled = false;

/** Предел на один запрос: тот же, что стоит на сервере. */
const BATCH = 200;

async function flush(): Promise<void> {
  scheduled = false;
  const ids = [...waiting.keys()].slice(0, BATCH);
  if (ids.length === 0) return;

  const asked = ids.map((id) => ({ id, callbacks: waiting.get(id) ?? [] }));
  for (const id of ids) waiting.delete(id);

  try {
    const found = await resolveMentions(ids);
    const byId = new Map(found.map((one) => [one.id, one]));
    const at = Date.now();
    for (const { id, callbacks } of asked) {
      // Отсутствие в ответе это ответ: человека нет. Записывается наравне с
      // найденным, иначе показ спрашивал бы про удалённого при каждой отрисовке.
      const target = byId.get(id) ?? null;
      known.set(id, { target, at });
      for (const one of callbacks) one.done(target);
    }
  } catch (error) {
    // Отказ не запоминается: сеть не должна превращать упоминание в «удалён»
    // до конца сеанса. Показ по отказу оставляет прежнюю подпись.
    for (const { callbacks } of asked) {
      for (const one of callbacks) one.fail(error);
    }
  }

  if (waiting.size > 0) schedule();
}

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  void Promise.resolve().then(flush);
}

/**
 * Разрешить одного.
 *
 * Отдаёт `null`, когда сервер ответил и такого человека нет. Отказ сети или
 * входа проходит наружу отказом: вызывающий по нему оставляет прежнюю подпись.
 */
export function mentionTarget(userId: string): Promise<MentionTarget | null> {
  const cached = known.get(userId);
  if (cached && Date.now() - cached.at < FRESH_MS) {
    return Promise.resolve(cached.target);
  }
  return new Promise((done, fail) => {
    const queue = waiting.get(userId);
    if (queue) {
      queue.push({ done, fail });
    } else {
      waiting.set(userId, [{ done, fail }]);
    }
    schedule();
  });
}
