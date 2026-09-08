/**
 * Ключ порядка между соседями.
 *
 * Порядок страниц в дереве и строк в базе хранится строкой, а не числом: при
 * перестановке меняется одна запись, а не весь список. Ключ новой позиции
 * считается между ключами соседей, и сравниваются они как строки.
 *
 * Разбор перенесён из `fractional-indexing`, которым пользуется v1 через
 * `fractional-indexing-jittered`. Перенесён, а не подключён: ключи лежат в
 * общей базе, и вторая версия обязана понимать уже записанные первой. Свой
 * формат означал бы дерево, которое в одной версии выглядит иначе, чем в
 * другой.
 *
 * Устройство ключа. Первый знак задаёт длину целой части: `a` это две буквы,
 * `b` три и так далее, заглавные — то же для отрицательных. Дальше идёт
 * дробная часть, и она никогда не кончается нулём — иначе у одного положения
 * было бы два написания и сравнение строк перестало бы совпадать с порядком.
 *
 * Без единого импорта намеренно: разбор проверяется сам по себе.
 */

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Наименьший возможный ключ. Уменьшать его дальше нечем. */
const SMALLEST = `A${DIGITS[0].repeat(26)}`;

export class OrderKeyError extends Error {}

/**
 * Ключ, стоящий строго между `before` и `after`.
 *
 * Пустое значение означает край: `keyBetween(null, null)` даёт первый ключ
 * списка, `keyBetween(last, null)` — ключ в конец.
 */
export function keyBetween(before: string | null, after: string | null): string {
  if (before !== null) validate(before);
  if (after !== null) validate(after);
  if (before !== null && after !== null && before >= after) {
    throw new OrderKeyError(`${before} >= ${after}`);
  }

  if (before === null) {
    if (after === null) return `a${DIGITS[0]}`;

    const whole = integerPart(after);
    const fraction = after.slice(whole.length);
    if (whole === SMALLEST) return whole + midpoint('', fraction);
    if (whole < after) return whole;

    const smaller = decrement(whole);
    if (smaller === null) throw new OrderKeyError('уменьшать больше нечего');
    return smaller;
  }

  if (after === null) {
    const whole = integerPart(before);
    const fraction = before.slice(whole.length);
    const bigger = increment(whole);
    return bigger === null ? whole + midpoint(fraction, null) : bigger;
  }

  const wholeBefore = integerPart(before);
  const fractionBefore = before.slice(wholeBefore.length);
  const wholeAfter = integerPart(after);
  const fractionAfter = after.slice(wholeAfter.length);

  if (wholeBefore === wholeAfter) return wholeBefore + midpoint(fractionBefore, fractionAfter);

  const bigger = increment(wholeBefore);
  if (bigger === null) throw new OrderKeyError('увеличивать больше нечего');
  if (bigger < after) return bigger;
  return wholeBefore + midpoint(fractionBefore, null);
}

/**
 * Ключи для перечня соседей, у которых их ещё нет.
 *
 * Страница, заведённая обычным путём, ключа не получает: пока её не двигали,
 * порядок задаёт время создания. Перед первой перестановкой такому списку
 * ключи надо раздать — иначе положение «между двумя без ключа» выразить нечем.
 *
 * Возвращает только те позиции, где ключ пришлось завести: остальные не
 * трогаются, и лишних записей в базе не появляется.
 */
export function fillKeys(
  positions: readonly (string | null | undefined)[]
): { index: number; key: string }[] {
  const filled: (string | null)[] = positions.map((one) => one ?? null);
  const added: { index: number; key: string }[] = [];

  for (let at = 0; at < filled.length; at += 1) {
    if (filled[at] !== null) continue;

    // Следующий заведённый ключ справа. Между ним и левым соседом и кладётся
    // новый: соседи справа без ключа получат свои на следующих шагах.
    let next: string | null = null;
    for (let ahead = at + 1; ahead < filled.length; ahead += 1) {
      if (filled[ahead] !== null) {
        next = filled[ahead];
        break;
      }
    }

    const key = keyBetween(at === 0 ? null : filled[at - 1], next);
    filled[at] = key;
    added.push({ index: at, key });
  }

  return added;
}

/** Длина целой части по её первому знаку. */
function wholeLength(head: string): number {
  if (head >= 'a' && head <= 'z') return head.charCodeAt(0) - 'a'.charCodeAt(0) + 2;
  if (head >= 'A' && head <= 'Z') return 'Z'.charCodeAt(0) - head.charCodeAt(0) + 2;
  throw new OrderKeyError(`негодный первый знак ключа: ${head}`);
}

function integerPart(key: string): string {
  const length = wholeLength(key[0]);
  if (length > key.length) throw new OrderKeyError(`негодный ключ: ${key}`);
  return key.slice(0, length);
}

function validate(key: string): void {
  if (!key) throw new OrderKeyError('пустой ключ');
  if (key === SMALLEST) throw new OrderKeyError(`негодный ключ: ${key}`);

  const whole = integerPart(key);
  if (whole.length !== wholeLength(whole[0])) throw new OrderKeyError(`негодный ключ: ${key}`);
  for (const one of key.slice(1)) {
    if (!DIGITS.includes(one)) throw new OrderKeyError(`негодный знак в ключе: ${key}`);
  }
  if (key.slice(whole.length).endsWith(DIGITS[0])) {
    throw new OrderKeyError(`негодный ключ: ${key}`);
  }
}

/**
 * Середина между двумя дробными частями.
 *
 * `after === null` означает «до конца»: середина берётся между `before` и
 * единицей.
 */
function midpoint(before: string, after: string | null): string {
  if (after !== null && before >= after) throw new OrderKeyError(`${before} >= ${after}`);
  if (before.endsWith(DIGITS[0]) || (after !== null && after.endsWith(DIGITS[0]))) {
    throw new OrderKeyError('дробная часть кончается нулём');
  }

  if (after !== null) {
    // Общее начало отрезается: середина ищется там, где строки расходятся.
    let same = 0;
    while ((before[same] ?? DIGITS[0]) === after[same]) same += 1;
    if (same > 0) return after.slice(0, same) + midpoint(before.slice(same), after.slice(same));
  }

  const first = before ? DIGITS.indexOf(before[0]) : 0;
  const last = after !== null ? DIGITS.indexOf(after[0]) : DIGITS.length;

  if (last - first > 1) return DIGITS[Math.round(0.5 * (first + last))];
  if (after !== null && after.length > 1) return after.slice(0, 1);
  // Знаки соседние: середина уходит на разряд правее.
  return DIGITS[first] + midpoint(before.slice(1), null);
}

function increment(whole: string): string | null {
  const head = whole[0];
  const digits = whole.slice(1).split('');

  let carry = true;
  for (let at = digits.length - 1; carry && at >= 0; at -= 1) {
    const next = DIGITS.indexOf(digits[at]) + 1;
    if (next === DIGITS.length) digits[at] = DIGITS[0];
    else {
      digits[at] = DIGITS[next];
      carry = false;
    }
  }

  if (!carry) return head + digits.join('');
  if (head === 'Z') return `a${DIGITS[0]}`;
  if (head === 'z') return null;

  const bigger = String.fromCharCode(head.charCodeAt(0) + 1);
  if (bigger > 'a') digits.push(DIGITS[0]);
  else digits.pop();
  return bigger + digits.join('');
}

function decrement(whole: string): string | null {
  const head = whole[0];
  const digits = whole.slice(1).split('');

  let borrow = true;
  for (let at = digits.length - 1; borrow && at >= 0; at -= 1) {
    const next = DIGITS.indexOf(digits[at]) - 1;
    if (next === -1) digits[at] = DIGITS[DIGITS.length - 1];
    else {
      digits[at] = DIGITS[next];
      borrow = false;
    }
  }

  if (!borrow) return head + digits.join('');
  if (head === 'a') return `Z${DIGITS[DIGITS.length - 1]}`;
  if (head === 'A') return null;

  const smaller = String.fromCharCode(head.charCodeAt(0) - 1);
  if (smaller < 'Z') digits.push(DIGITS[DIGITS.length - 1]);
  else digits.pop();
  return smaller + digits.join('');
}
