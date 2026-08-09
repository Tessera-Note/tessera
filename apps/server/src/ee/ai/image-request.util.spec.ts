import { buildImageQuery } from './image-request.util';

/**
 * Замерено на живом случае: на просьбу «с описанием и фото» агент поставил
 * ссылку на источник и ни одной картинки.
 */
describe('buildImageQuery', () => {
  it('слова про формат из запроса убираются', () => {
    const query = buildImageQuery(
      'сделай страницу: постеры фильмов Дюна и Оппенгеймер с фото',
    );

    expect(query).not.toContain('постер');
    expect(query).not.toContain('фото');
    expect(query).toContain('дюна');
  });

  it('запрос остается коротким', () => {
    const query = buildImageQuery(
      'создай страницу с текущими 13 фильмами которые в прокате в топ 13 с описанием и фото',
    );

    expect(query.split(' ').length).toBeLessThanOrEqual(5);
  });

  it('сообщение из одних слов про формат не остается пустым', () => {
    expect(buildImageQuery('добавь фото').length).toBeGreaterThan(0);
  });
});
