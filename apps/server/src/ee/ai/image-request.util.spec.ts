import { buildImageQuery, needsImages } from './image-request.util';

/**
 * Замерено на живом случае: на просьбу «с описанием и фото» агент поставил
 * ссылку на источник и ни одной картинки.
 */
describe('needsImages', () => {
  it.each([
    'создай страницу с описанием и фото',
    'добавь постеры фильмов',
    'нужны картинки к каждому пункту',
    'add posters for each film',
    'with images please',
  ])('распознается просьба про изображения: %s', (query) => {
    expect(needsImages(query)).toBe(true);
  });

  it.each([
    'создай страницу с топом фильмов',
    'что записано про отпуска',
    'перепиши заголовок',
  ])('обычная просьба изображений не требует: %s', (query) => {
    expect(needsImages(query)).toBe(false);
  });

  it('пустое сообщение изображений не требует', () => {
    expect(needsImages('')).toBe(false);
  });
});

/**
 * Слова про формат описывают не предмет поиска, а то, что с ним сделать, и в
 * запросе изображений только мешают.
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
