import { describe, expect, it } from 'vitest';
import { ApiError, errorText } from '$lib/api/failure';

const DICTIONARY: Record<string, string> = {
  'error.space.last_admin': 'В пространстве должен остаться администратор',
  'Something went wrong': 'Что-то пошло не так',
  'error.page.too_deep': 'Глубже нельзя, предел {{limit}}'
};

/** Переводчик поверх словаря: отсутствующий ключ возвращается как есть. */
function t(key: string, values?: Record<string, string | number>): string {
  const found = DICTIONARY[key] ?? key;
  return found.replace(/\{\{(\w+)\}\}/g, (whole, name) => String(values?.[name] ?? whole));
}

describe('текст отказа', () => {
  it('переводит код, который есть в словаре', () => {
    const failure = new ApiError(400, 'error.space.last_admin', 'Last admin', {});
    expect(errorText(failure, t)).toBe('В пространстве должен остаться администратор');
  });

  it('подставляет значения в перевод', () => {
    const failure = new ApiError(400, 'error.page.too_deep', 'Too deep', { limit: 10 });
    expect(errorText(failure, t)).toBe('Глубже нельзя, предел 10');
  });

  it('при промахе словаря берёт текст сервера, а не сырой код', () => {
    // Ради этого случая функция и написана: кодов у сервера сто девяносто
    // пять, подписей в словаре сорок два, и на экране появлялась точка-строка.
    const failure = new ApiError(400, 'error.space.slug_taken', 'This short name is taken', {});
    expect(errorText(failure, t)).toBe('This short name is taken');
  });

  it('без текста сервера отвечает общей фразой', () => {
    const failure = new ApiError(500, 'error.common.unknown', '', {});
    expect(errorText(failure, t)).toBe('Что-то пошло не так');
  });

  it('не показывает код, даже когда сервер положил его в текст', () => {
    // `ApiError` подставляет код в `message`, если тела не было: показать его
    // значит вернуться ровно к тому, что чинится.
    const failure = new ApiError(500, 'error.common.unknown', 'error.common.unknown', {});
    expect(errorText(failure, t)).toBe('Что-то пошло не так');
  });

  it('чужая ошибка это общая фраза', () => {
    expect(errorText(new TypeError('fetch failed'), t)).toBe('Что-то пошло не так');
    expect(errorText(undefined, t)).toBe('Что-то пошло не так');
  });
});
