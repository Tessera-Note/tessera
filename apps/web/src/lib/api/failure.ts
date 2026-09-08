/**
 * Отказ сервера и его текст для человека.
 *
 * Отдельно от `client.ts` намеренно: тот тянет адрес API, а с ним модули
 * SvelteKit, и проверить разбор отказа, не поднимая половину приложения, было
 * бы нельзя. Здесь нет ни одного импорта — это и есть причина.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly params: Record<string, string | number>;

  constructor(
    status: number,
    code: string,
    message: string,
    params: Record<string, string | number>
  ) {
    super(message || code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.params = params;
  }

  /** Вход потерян: сессия отозвана, истекла или её не было. */
  get unauthenticated(): boolean {
    return this.status === 401;
  }
}

/** Переводчик, каким его отдаёт `locale.t`. */
type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * Текст отказа для человека.
 *
 * Порядок такой. Сначала словарь по коду: перевод на язык человека — то, ради
 * чего сервер и отвечает кодом, а не текстом. Если кода в словаре нет, берётся
 * `message` от сервера: он английский, но это осмысленная фраза, а не
 * `error.space.slug_taken` на экране. Если нет и его — общая фраза.
 *
 * Промах словаря узнаётся по возврату самого ключа: `translate` при
 * отсутствующем ключе отдаёт его как есть.
 *
 * Понадобилось это потому, что кодов у сервера сто девяносто пять, а подписей
 * в словаре сорок два. Раньше человек видел сырой код, и хуже всего это было
 * там, где текст у сервера как раз есть.
 */
export function errorText(failure: unknown, t: Translate): string {
  if (!(failure instanceof ApiError)) {
    return t('Something went wrong');
  }

  const translated = t(failure.code, failure.params);
  if (translated !== failure.code) {
    return translated;
  }

  const message = failure.message.trim();
  return message && message !== failure.code ? message : t('Something went wrong');
}
