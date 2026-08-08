import { load } from 'cheerio';
import { confluenceFormatter } from './import-formatter';

const format = (html: string) => {
  const $ = load(html);
  const $root = $.root();
  confluenceFormatter($, $root);
  return $root.html() ?? '';
};

const panel = (kind: string, text: string) =>
  `<div class="confluence-information-macro confluence-information-macro-${kind}">
     <span class="aui-icon confluence-information-macro-icon"></span>
     <div class="confluence-information-macro-body"><p>${text}</p></div>
   </div>`;

describe('confluenceFormatter, панели в выноски', () => {
  // Соответствие по смыслу: warning в Confluence это красная панель ошибки.
  it.each([
    ['information', 'info'],
    ['tip', 'success'],
    ['note', 'note'],
    ['warning', 'danger'],
  ])('панель %s становится выноской %s', (kind, expected) => {
    const html = format(panel(kind, 'Текст панели'));

    expect(html).toContain('data-type="callout"');
    expect(html).toContain(`data-callout-type="${expected}"`);
    expect(html).toContain('Текст панели');
  });

  it('неизвестный вид панели становится info', () => {
    const html = format(panel('неизвестно', 'Текст'));

    expect(html).toContain('data-callout-type="info"');
  });

  it('панель без тела сохраняет свое содержимое', () => {
    const html = format(
      '<div class="confluence-information-macro confluence-information-macro-note"><p>Прямо внутри</p></div>',
    );

    expect(html).toContain('Прямо внутри');
  });

  it('иконка панели не превращается в текст', () => {
    const html = format(panel('information', 'Текст'));

    expect(html).not.toContain('aui-icon');
  });
});

describe('confluenceFormatter, раскрывающийся блок', () => {
  const expand = `
    <div class="expand-container">
      <div class="expand-control"><span class="expand-control-text">Подробности развертывания</span></div>
      <div class="expand-content"><p>Скрытый текст.</p></div>
    </div>`;

  it('становится details с заголовком и содержимым', () => {
    const html = format(expand);

    expect(html).toContain('<details>');
    expect(html).toContain('<summary>Подробности развертывания</summary>');
    expect(html).toContain('data-type="detailsContent"');
    expect(html).toContain('Скрытый текст.');
  });

  it('без заголовка подставляется запасной', () => {
    const html = format(
      '<div class="expand-container"><div class="expand-content"><p>Текст</p></div></div>',
    );

    expect(html).toContain('<summary>Подробности</summary>');
  });
});

describe('confluenceFormatter, панель кода', () => {
  const codePanel = `
    <div class="code panel pdl">
      <div class="codeHeader panelHeader pdl"><b>Пример команды</b></div>
      <div class="codeContent panelContent pdl">
        <pre class="syntaxhighlighter-pre" data-syntaxhighlighter-params="brush: bash; gutter: false">docker compose up -d</pre>
      </div>
    </div>`;

  it('становится блоком кода с языком', () => {
    const html = format(codePanel);

    expect(html).toContain('<pre><code class="language-bash">');
    expect(html).toContain('docker compose up -d');
  });

  // У блока кода нет своего заголовка, выбрасывать подпись нельзя.
  it('заголовок панели остается абзацем перед кодом', () => {
    const html = format(codePanel);

    expect(html).toContain('<strong>Пример команды</strong>');
    expect(html.indexOf('Пример команды')).toBeLessThan(
      html.indexOf('docker compose'),
    );
  });

  it('без параметров подсветки язык не ставится', () => {
    const html = format(
      '<div class="code panel"><div class="codeContent"><pre>текст</pre></div></div>',
    );

    expect(html).toContain('<pre><code>текст</code></pre>');
  });

  it('панель без pre не трогается', () => {
    const html = format('<div class="code panel"><p>нет кода</p></div>');

    expect(html).toContain('нет кода');
  });
});

describe('confluenceFormatter, статусы', () => {
  it.each([
    ['success', 'green'],
    ['error', 'red'],
    ['current', 'blue'],
    ['moved', 'yellow'],
  ])('плашка %s дает цвет %s', (lozenge, color) => {
    const html = format(
      `<span class="status-macro aui-lozenge aui-lozenge-${lozenge}">ГОТОВО</span>`,
    );

    expect(html).toContain('data-type="status"');
    expect(html).toContain(`data-color="${color}"`);
    expect(html).toContain('ГОТОВО');
  });

  it('неизвестная плашка дает серый', () => {
    const html = format(
      '<span class="status-macro aui-lozenge aui-lozenge-неизвестно">ТЕКСТ</span>',
    );

    expect(html).toContain('data-color="gray"');
  });
});

/**
 * Молчаливая потеря содержимого недопустима: читатель перенесенной страницы
 * должен видеть, что на этом месте что-то было.
 */
describe('confluenceFormatter, непереносимые макросы', () => {
  it('пустое оглавление заменяется видимой отбивкой', () => {
    const html = format('<div class="toc-macro client-side-toc-macro"></div>');

    expect(html).toContain('[макрос Confluence не перенесен: оглавление]');
  });

  it('пустой виджет Jira заменяется отбивкой', () => {
    const html = format('<div class="plugin_jira"></div>');

    expect(html).toContain('[макрос Confluence не перенесен: виджет Jira]');
  });

  // Если содержимое доехало, отбивка не нужна и только мешала бы.
  it('макрос с содержимым отбивкой не заменяется', () => {
    const html = format(
      '<div class="plugin_jira"><a href="https://jira.example.com/browse/OPS-1">OPS-1</a></div>',
    );

    expect(html).not.toContain('не перенесен');
    expect(html).toContain('OPS-1');
  });
});

describe('confluenceFormatter, чужая разметка', () => {
  // Форматтер вызывается на всех источниках импорта.
  it('обычный html не меняется', () => {
    const source = '<p>Просто абзац</p><ul><li>Пункт</li></ul>';

    // cheerio оборачивает ввод в html и body, поэтому сравнивается
    // содержимое, а не строка целиком.
    expect(format(source)).toContain(source);
  });

  it('разметка Notion не трогается', () => {
    const source = '<div class="page-body"><p>Текст Notion</p></div>';

    expect(format(source)).toContain(source);
  });
});
