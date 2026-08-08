import { normalizePageReference } from './page-reference.util';

/**
 * Пользователь внутреннего идентификатора страницы не видит: такого поля в
 * продукте нет. Он дает то, что у него есть, и все эти формы обязаны
 * приниматься.
 */
describe('normalizePageReference, формы из транскрипта', () => {
  it('адрес страницы из строки браузера', () => {
    expect(
      normalizePageReference('http://localhost:3000/s/general/p/filmy-pOHJzJpYni'),
    ).toBe('pOHJzJpYni');
  });

  it('адрес общего доступа', () => {
    expect(
      normalizePageReference(
        'http://localhost:3000/share/sgsskwsf71/p/filmy-pOHJzJpYni',
      ),
    ).toBe('pOHJzJpYni');
  });

  it('слаг целиком', () => {
    expect(normalizePageReference('filmy-pOHJzJpYni')).toBe('pOHJzJpYni');
  });

  it('только slug_id', () => {
    expect(normalizePageReference('pOHJzJpYni')).toBe('pOHJzJpYni');
  });

  it('идентификатор проходит как есть', () => {
    const id = '019fd2c3-8b03-77e3-9a65-a7714d75494f';
    expect(normalizePageReference(id)).toBe(id);
  });
});

describe('normalizePageReference, прочие формы', () => {
  it('путь без хоста', () => {
    expect(normalizePageReference('/s/general/p/notes-AbCdEf1234')).toBe(
      'AbCdEf1234',
    );
  });

  it('якорь и параметры отбрасываются', () => {
    expect(
      normalizePageReference('/s/general/p/notes-AbCdEf1234?x=1#section'),
    ).toBe('AbCdEf1234');
  });

  // Модель нередко оборачивает ссылку в скобки или кавычки.
  it('обертки снимаются', () => {
    expect(normalizePageReference('<http://h/s/g/p/n-AbCdEf1234>')).toBe(
      'AbCdEf1234',
    );
    expect(normalizePageReference('"n-AbCdEf1234"')).toBe('AbCdEf1234');
  });

  it('заголовок с дефисами не мешает', () => {
    expect(normalizePageReference('очень-длинное-имя-AbCdEf1234')).toBe(
      'AbCdEf1234',
    );
  });

  it('пустое и не строка дают undefined', () => {
    expect(normalizePageReference('')).toBeUndefined();
    expect(normalizePageReference('   ')).toBeUndefined();
    expect(normalizePageReference(null)).toBeUndefined();
    expect(normalizePageReference(42)).toBeUndefined();
  });

  it('адрес без сегмента страницы дает undefined', () => {
    expect(
      normalizePageReference('http://localhost:3000/s/general/p/'),
    ).toBeUndefined();
  });

  it('идентификатор в адресе не режется', () => {
    expect(
      normalizePageReference(
        '/s/general/p/019fd2c3-8b03-77e3-9a65-a7714d75494f',
      ),
    ).toBe('019fd2c3-8b03-77e3-9a65-a7714d75494f');
  });
});
