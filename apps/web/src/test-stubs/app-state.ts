/**
 * `$app/state` для проверок разметки.
 *
 * SvelteKit подставляет этот модуль сам, а проверки идут мимо него. Здесь
 * оставлено то, чем пользуются экраны: адрес страницы, а для страницы отказа —
 * ещё и код с причиной. Проверка ставит их до отрисовки — так же, как это
 * делает переход по ссылке.
 */
export const page: {
  url: URL;
  params: Record<string, string>;
  status: number;
  error: { message?: string; code?: string } | null;
} = {
  url: new URL('http://localhost/'),
  params: {},
  status: 200,
  error: null
};
