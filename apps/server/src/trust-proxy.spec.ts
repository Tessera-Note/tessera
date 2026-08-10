import Fastify from 'fastify';

/**
 * Адрес запроса не должен подставляться заголовком.
 *
 * Приложение поднималось с `trustProxy: true`, то есть доверяло всей цепочке
 * `X-Forwarded-For` и брало самое левое значение, присланное клиентом. По
 * `req.ip` считаются пороги частоты и пишется адрес в журнал аудита, значит
 * доверие всей цепочке давало и обход лимита подстановкой заголовка, и
 * подделку адреса в журнале. На публичном маршруте отрисовки PDF адрес вообще
 * единственная идентичность, и перебор токена ограничивался только им.
 *
 * Проверяется поведение настоящего Fastify, а не написание в `main.ts`:
 * значение `trustProxy` меняет разбор заголовка, и убедиться в этом можно
 * только разобрав заголовок.
 */
async function ipFor(
  trustProxy: boolean | number,
  forwardedFor: string,
): Promise<string> {
  const app = Fastify({ trustProxy });
  app.get('/', async (req) => ({ ip: req.ip }));
  await app.listen({ port: 0, host: '127.0.0.1' });

  try {
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { 'x-forwarded-for': forwardedFor },
    });

    return ((await res.json()) as { ip: string }).ip;
  } finally {
    await app.close();
  }
}

/** Так выглядит заголовок после обратного прокси: слева присланное клиентом,
 * справа реальный адрес, приписанный прокси. */
const SPOOFED_THEN_REAL = '203.0.113.99, 10.0.0.7';

describe('доверие заголовку X-Forwarded-For', () => {
  it('доверие всей цепочке отдает присланное клиентом значение', async () => {
    await expect(ipFor(true, SPOOFED_THEN_REAL)).resolves.toBe('203.0.113.99');
  });

  it('один доверенный переход отдает адрес от прокси', async () => {
    await expect(ipFor(1, SPOOFED_THEN_REAL)).resolves.toBe('10.0.0.7');
  });

  /**
   * Цепочка произвольной длины подставляется так же просто, как одно значение.
   * Число доверенных переходов режет ее с конца, поэтому длина заголовка на
   * результат не влияет.
   */
  it('длинная подставленная цепочка ничего не меняет', async () => {
    await expect(
      ipFor(1, '1.1.1.1, 2.2.2.2, 3.3.3.3, 203.0.113.99, 10.0.0.7'),
    ).resolves.toBe('10.0.0.7');
  });

  it('без заголовка берется адрес соединения', async () => {
    await expect(ipFor(1, '')).resolves.toBe('127.0.0.1');
  });
});
