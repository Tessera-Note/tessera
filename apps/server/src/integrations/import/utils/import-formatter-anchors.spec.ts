import { load } from 'cheerio';
import { rewriteInternalLinksToMentionHtml } from './import-formatter';

/**
 * Регресс со стенда: ссылка на раздел другой страницы оставалась сырым
 * путем из архива (`Вторая_102.html#razdel`), то есть битой ссылкой.
 */
describe('rewriteInternalLinksToMentionHtml, якоря', () => {
  const META = new Map([
    [
      'Вторая_102.html',
      { id: 'page-2', title: 'Вторая страница', slugId: 'aBcD' },
    ],
  ]);

  const rewrite = async (html: string) => {
    const $ = load(html);
    const $root = $.root();
    const backlinks = await rewriteInternalLinksToMentionHtml(
      $,
      $root,
      'Первая_101.html',
      META as any,
      'user-1',
      'page-1',
      'ws-1',
      'general',
    );
    return { html: $root.html() ?? '', backlinks };
  };

  it('ссылка с якорем ведет на страницу и сохраняет якорь', async () => {
    const { html } = await rewrite(
      '<a href="%D0%92%D1%82%D0%BE%D1%80%D0%B0%D1%8F_102.html#razdel">Вторая страница</a>',
    );

    expect(html).toContain('/s/general/p/vtoraya-stranitsa-aBcD#razdel');
    expect(html).toContain('data-internal="true"');
  });

  // Упоминание ведет на страницу целиком, якорь при этом теряется.
  it('ссылка с якорем не превращается в упоминание', async () => {
    const { html } = await rewrite(
      '<a href="Вторая_102.html#razdel">Вторая страница</a>',
    );

    expect(html).not.toContain('data-type="mention"');
  });

  it('ссылка без якоря по-прежнему становится упоминанием', async () => {
    const { html } = await rewrite(
      '<a href="Вторая_102.html">Вторая страница</a>',
    );

    expect(html).toContain('data-type="mention"');
    expect(html).toContain('data-entity-id="page-2"');
  });

  it('ссылка с другим текстом становится внутренней ссылкой', async () => {
    const { html } = await rewrite('<a href="Вторая_102.html">смотри тут</a>');

    expect(html).toContain('/s/general/p/vtoraya-stranitsa-aBcD');
    expect(html).not.toContain('data-type="mention"');
  });

  // Ссылка на якорь внутри той же страницы и так работает.
  it('якорь без пути не трогается', async () => {
    const { html } = await rewrite('<a href="#razdel">к разделу</a>');

    expect(html).toContain('href="#razdel"');
    expect(html).not.toContain('data-internal');
  });

  it('внешняя ссылка не трогается', async () => {
    const { html } = await rewrite('<a href="https://example.com">пример</a>');

    expect(html).toContain('https://example.com');
    expect(html).not.toContain('data-internal');
  });

  /**
   * Прежде такая ссылка оставалась относительным путем к файлу, которого на
   * сервере нет: заведомо битая ссылка выглядела рабочей, и человек узнавал
   * правду только нажав. Адрес был осмыслен только внутри архива, слова
   * остаются на месте.
   */
  it('ссылка на страницу вне выгрузки разворачивается в текст', async () => {
    const { html } = await rewrite('<a href="Третья_103.html">Третья</a>');

    expect(html).not.toContain('Третья_103.html');
    expect(html).not.toContain('<a');
    expect(html).toContain('Третья');
  });

  it('внешняя ссылка при этом остается ссылкой', async () => {
    const { html } = await rewrite('<a href="https://example.com">пример</a>');

    expect(html).toContain('<a');
    expect(html).toContain('https://example.com');
  });

  it('якорь внутри той же страницы не трогается', async () => {
    const { html } = await rewrite('<a href="#razdel">Раздел</a>');

    expect(html).toContain('#razdel');
  });

  it('обратная связь записывается для ссылки с якорем', async () => {
    const { backlinks } = await rewrite(
      '<a href="Вторая_102.html#razdel">Вторая страница</a>',
    );

    expect(backlinks).toEqual([
      { sourcePageId: 'page-1', targetPageId: 'page-2', workspaceId: 'ws-1' },
    ]);
  });

  it('якорь с решеткой внутри сохраняется целиком', async () => {
    const { html } = await rewrite('<a href="Вторая_102.html#a#b">смотри</a>');

    expect(html).toContain('#a#b');
  });
});
