import {
  isConfluenceExport,
  parseConfluenceAttachments,
  parseConfluenceTree,
  extractConfluencePage,
  titleFromFileName,
} from './confluence-archive';

const INDEX_HTML = `
<html><body>
  <div id="main-content">
    <div class="pageSection">
      <h2>Available Pages:</h2>
      <ul>
        <li>
          <a href="Regламент_98765.html">Регламент</a>
          <ul>
            <li><a href="%D0%9F%D1%80%D0%B8%D0%BB%D0%BE%D0%B6%D0%B5%D0%BD%D0%B8%D0%B5_11111.html">Приложение</a></li>
            <li>
              <a href="Poryadok_22222.html">Порядок</a>
              <ul><li><a href="Shag_33333.html">Шаг первый</a></li></ul>
            </li>
          </ul>
        </li>
        <li><a href="Slovar_44444.html">Словарь</a></li>
      </ul>
    </div>
  </div>
</body></html>`;

describe('confluence-archive, распознавание выгрузки', () => {
  it('индекс выгрузки Confluence распознается', () => {
    expect(isConfluenceExport(INDEX_HTML)).toBe(true);
  });

  // Признак берется из разметки, а не из имени файла: index.html есть
  // в любом архиве.
  it('чужой index.html не принимается за выгрузку', () => {
    expect(
      isConfluenceExport('<html><body><h1>Просто страница</h1></body></html>'),
    ).toBe(false);
  });

  it('пустой ввод не роняет проверку', () => {
    expect(isConfluenceExport('')).toBe(false);
  });
});

describe('confluence-archive, дерево страниц', () => {
  it('строится по вложенным спискам, а не по каталогам', () => {
    const tree = parseConfluenceTree(INDEX_HTML);

    expect(tree).toHaveLength(2);
    expect(tree[0].title).toBe('Регламент');
    expect(tree[0].children.map((c) => c.title)).toEqual([
      'Приложение',
      'Порядок',
    ]);
    expect(tree[0].children[1].children[0].title).toBe('Шаг первый');
    expect(tree[1].title).toBe('Словарь');
  });

  // Имена файлов в архиве лежат в исходном виде, а ссылки закодированы
  // процентами: без раскодирования страница не находится.
  it('ссылка с процентным кодированием раскодируется', () => {
    const tree = parseConfluenceTree(INDEX_HTML);

    expect(tree[0].children[0].href).toBe('Приложение_11111.html');
  });

  it('порядок братьев сохраняется как в выгрузке', () => {
    const tree = parseConfluenceTree(INDEX_HTML);

    expect(tree.map((n) => n.href)).toEqual([
      'Regламент_98765.html',
      'Slovar_44444.html',
    ]);
  });

  it('повторное вхождение страницы отбрасывается', () => {
    const withDuplicate = INDEX_HTML.replace(
      '</ul>\n    </div>',
      '<li><a href="Slovar_44444.html">Словарь</a></li></ul></div>',
    );

    const hrefs = parseConfluenceTree(withDuplicate).map((n) => n.href);

    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('ссылки не на страницы пропускаются', () => {
    const html = `<div id="main-content"><ul>
      <li><a href="attachments/1/2.png">картинка</a></li>
      <li><a href="Stranica_1.html">страница</a></li>
    </ul></div>`;

    const tree = parseConfluenceTree(html);

    expect(tree).toHaveLength(1);
    expect(tree[0].href).toBe('Stranica_1.html');
  });

  it('индекс без списков дает пустое дерево', () => {
    expect(parseConfluenceTree('<div id="main-content"></div>')).toEqual([]);
  });
});

describe('confluence-archive, содержимое страницы', () => {
  const PAGE = `
    <html><body>
      <div id="breadcrumb-section"><ol class="breadcrumb"><li>Пространство</li></ol></div>
      <h1 id="title-heading"><span id="title-text">Регламент резервного копирования</span></h1>
      <div id="main-content">
        <div class="page-metadata">Создано пользователем Иванов</div>
        <p>Дамп снимается ежедневно.</p>
        <ul><li>Остановить приложение</li></ul>
        <div class="pageSection group"><h2>Attachments:</h2></div>
      </div>
      <div id="footer">Экспортировано Confluence</div>
    </body></html>`;

  it('заголовок берется из title-text', () => {
    expect(extractConfluencePage(PAGE).title).toBe(
      'Регламент резервного копирования',
    );
  });

  it('содержимое берется из main-content', () => {
    const { html } = extractConfluencePage(PAGE);

    expect(html).toContain('Дамп снимается ежедневно');
    expect(html).toContain('Остановить приложение');
  });

  // Обвязка самой Confluence в страницу не переносится.
  it('служебные разделы вырезаются', () => {
    const { html } = extractConfluencePage(PAGE);

    expect(html).not.toContain('Создано пользователем');
    expect(html).not.toContain('Attachments:');
    expect(html).not.toContain('Экспортировано Confluence');
    expect(html).not.toContain('Пространство');
  });

  it('страница без main-content дает пустое содержимое', () => {
    const { html, title } = extractConfluencePage(
      '<html><head><title>Заголовок</title></head><body></body></html>',
    );

    expect(html).toBe('');
    expect(title).toBe('Заголовок');
  });

  it('пустой ввод не роняет разбор', () => {
    expect(extractConfluencePage('')).toEqual({ title: '', html: '' });
  });
});

describe('confluence-archive, запасной заголовок', () => {
  it.each([
    ['Регламент_98765.html', 'Регламент'],
    ['Poryadok deystviy_12.html', 'Poryadok deystviy'],
    ['Bez id.html', 'Bez id'],
  ])('имя файла %s дает заголовок %s', (file, expected) => {
    expect(titleFromFileName(file)).toBe(expected);
  });
});

/**
 * Confluence Server кладет файлы под числовыми именами без расширения,
 * а настоящее имя и тип содержимого пишет рядом со ссылкой.
 */
describe('confluence-archive, вложения страницы', () => {
  const WITH_ATTACHMENTS = `
    <div id="main-content">
      <p>Текст страницы</p>
      <div class="pageSection group">
        <div class="pageSectionHeader"><h2 id="attachments">Attachments:</h2></div>
        <div class="greybox" align="left">
          <img src="images/icons/bullet_blue.gif" height="8" width="8" alt=""/>
          <a href="attachments/65601/65602.png">схема.png</a> (image/png)
          <br/>
          <a href="attachments/65601/65603">заметки</a> (application/octet-stream)
          <br/>
          <a href="attachments/65601/65604.drawio">архитектура.drawio</a> (application/vnd.jgraph.mxfile)
          <br/>
        </div>
      </div>
    </div>`;

  it('вложения разбираются со ссылкой, именем и типом', () => {
    const list = parseConfluenceAttachments(WITH_ATTACHMENTS);

    expect(list).toHaveLength(3);
    expect(list[0]).toEqual({
      href: 'attachments/65601/65602.png',
      fileName: 'схема.png',
      mimeType: 'image/png',
    });
  });

  // Файл без расширения это обычный случай выгрузки Confluence Server.
  it('файл без расширения сохраняет настоящее имя', () => {
    const list = parseConfluenceAttachments(WITH_ATTACHMENTS);

    expect(list[1]).toEqual({
      href: 'attachments/65601/65603',
      fileName: 'заметки',
      mimeType: 'application/octet-stream',
    });
  });

  it('вложение draw.io распознается по типу', () => {
    const list = parseConfluenceAttachments(WITH_ATTACHMENTS);

    expect(list[2].fileName).toBe('архитектура.drawio');
    expect(list[2].mimeType).toBe('application/vnd.jgraph.mxfile');
  });

  // Выдумывать octet-stream значило бы скрыть настоящий тип файла.
  it('без типа в скобках отдается пустая строка', () => {
    const list = parseConfluenceAttachments(
      '<div class="pageSection group"><h2>Attachments:</h2><div class="greybox"><a href="attachments/1/2">файл</a></div></div>',
    );

    expect(list[0].mimeType).toBe('');
  });

  it('картинки-маркеры без имени пропускаются', () => {
    const list = parseConfluenceAttachments(WITH_ATTACHMENTS);

    expect(list.every((a) => a.fileName.length > 0)).toBe(true);
  });

  it('повторная ссылка отбрасывается', () => {
    const html = `<div class="pageSection group"><h2>Attachments:</h2><div class="greybox">
      <a href="attachments/1/2">файл</a> (text/plain)
      <a href="attachments/1/2">файл</a> (text/plain)
    </div></div>`;

    expect(parseConfluenceAttachments(html)).toHaveLength(1);
  });

  it('страница без вложений дает пустой список', () => {
    expect(
      parseConfluenceAttachments('<div id="main-content"><p>Текст</p></div>'),
    ).toEqual([]);
  });

  it('пустой ввод не роняет разбор', () => {
    expect(parseConfluenceAttachments('')).toEqual([]);
  });

  // Раздел вложений вырезается из содержимого, но разбирать его надо
  // до вырезания.
  it('список вложений не попадает в содержимое страницы', () => {
    const { html } = extractConfluencePage(WITH_ATTACHMENTS);

    expect(html).toContain('Текст страницы');
    expect(html).not.toContain('схема.png');
  });
});
