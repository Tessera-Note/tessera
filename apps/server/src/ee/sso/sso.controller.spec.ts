import { SsoController } from './sso.controller';

/**
 * Адрес, по которому администратор открыл интерфейс.
 *
 * Нужен для сверки с `APP_URL`. Ошибка здесь дает не отказ, а молчание:
 * сверка просто не сработает, и расхождение всплывет позже отказом каждого
 * входа. Поэтому все четыре исхода проверяются явно.
 */
function origin(headers: Record<string, unknown>): string | undefined {
  const controller = new SsoController({} as any);
  return (controller as any).origin({ headers });
}

describe('SsoController, адрес интерфейса', () => {
  it('берется из Origin', () => {
    expect(origin({ origin: 'https://wiki.local' })).toBe('https://wiki.local');
  });

  // Часть браузеров не шлет Origin на однодоменные запросы.
  it('при отсутствии Origin берется из Referer', () => {
    expect(origin({ referer: 'https://wiki.local/settings/security' })).toBe(
      'https://wiki.local',
    );
  });

  it('Origin имеет приоритет над Referer', () => {
    expect(
      origin({
        origin: 'https://wiki.local',
        referer: 'https://other.local/страница',
      }),
    ).toBe('https://wiki.local');
  });

  it('без обоих заголовков сверять нечего', () => {
    expect(origin({})).toBeUndefined();
  });

  it('пустой Origin не считается адресом', () => {
    expect(origin({ origin: '' })).toBeUndefined();
  });

  it('неразбираемый Referer не роняет запрос', () => {
    expect(origin({ referer: 'не адрес' })).toBeUndefined();
  });

  // Заголовок может прийти списком, тогда это не строка.
  it('заголовок списком отбрасывается', () => {
    expect(origin({ origin: ['https://a', 'https://b'] })).toBeUndefined();
  });
});
