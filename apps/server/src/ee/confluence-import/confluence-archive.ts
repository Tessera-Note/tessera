import { load, CheerioAPI } from 'cheerio';

/**
 * Узел дерева страниц выгрузки Confluence.
 *
 * `href` это имя файла страницы внутри архива, оно же ключ, по которому
 * страницы связываются между собой ссылками.
 */
export type ConfluenceTreeNode = {
  href: string;
  title: string;
  children: ConfluenceTreeNode[];
};

/**
 * Вложение страницы из раздела «Attachments» выгрузки.
 *
 * Форма совпадает с той, что ждет `processAttachments`: `href` это путь
 * внутри архива, `fileName` настоящее имя файла, `mimeType` тип из выгрузки.
 */
export type ConfluenceAttachment = {
  href: string;
  fileName: string;
  mimeType: string;
};

/** Заголовок и содержимое одной страницы выгрузки. */
export type ConfluencePageContent = {
  title: string;
  html: string;
};

/**
 * Признак выгрузки Confluence в HTML.
 *
 * Проверяется не по имени файла, а по разметке: `index.html` встречается
 * в любом архиве, а разделы `#main-content` вместе со списком страниц
 * характерны именно для выгрузки пространства Confluence.
 */
export function isConfluenceExport(indexHtml: string): boolean {
  if (!indexHtml) return false;
  const $ = load(indexHtml);
  const hasMainContent = $('#main-content').length > 0;
  const hasPageSection = $('.pageSection').length > 0;
  const hasPageLinks =
    $('#main-content a[href$=".html"], .pageSection a[href$=".html"]').length >
    0;
  return hasMainContent && (hasPageSection || hasPageLinks);
}

/**
 * Дерево страниц из index.html.
 *
 * Иерархия в выгрузке задана вложенными списками, а не структурой каталогов:
 * все страницы лежат в корне архива плоско, поэтому построить дерево по
 * файловой системе, как это делает generic-импорт, нельзя.
 *
 * Учитывается только последний раздел со списком страниц: выше в index.html
 * идут ссылки на вложения и на пространство, они страницами не являются.
 */
export function parseConfluenceTree(indexHtml: string): ConfluenceTreeNode[] {
  if (!indexHtml) return [];
  const $ = load(indexHtml);

  const containers = $('#main-content ul, .pageSection ul');
  if (containers.length === 0) return [];

  // Верхним считается список, у которого нет родительского ul: вложенные
  // разбираются рекурсивно вместе с ним.
  const roots: ConfluenceTreeNode[] = [];
  containers.each((_, element) => {
    const $list = $(element);
    if ($list.parents('ul').length > 0) return;
    roots.push(...parseList($, $list));
  });

  return dedupeByHref(roots);
}

function parseList($: CheerioAPI, $list: any): ConfluenceTreeNode[] {
  const nodes: ConfluenceTreeNode[] = [];

  $list.children('li').each((_: number, item: any) => {
    const $item = $(item);
    const $link = $item.children('a[href]').first();
    const href = ($link.attr('href') ?? '').trim();

    if (!href || !href.toLowerCase().endsWith('.html')) return;

    const $nested = $item.children('ul').first();
    nodes.push({
      href: decodeHref(href),
      title: $link.text().trim(),
      children: $nested.length ? parseList($, $nested) : [],
    });
  });

  return nodes;
}

/**
 * Ссылки в index.html закодированы процентами, а имена файлов в архиве
 * лежат в исходном виде. Без раскодирования страница не находится.
 */
function decodeHref(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

/**
 * Одна и та же страница может встретиться в нескольких списках index.html.
 * Побеждает первое вхождение: у него, как правило, заполнены потомки.
 */
function dedupeByHref(nodes: ConfluenceTreeNode[]): ConfluenceTreeNode[] {
  const seen = new Set<string>();

  const walk = (list: ConfluenceTreeNode[]): ConfluenceTreeNode[] => {
    const result: ConfluenceTreeNode[] = [];
    for (const node of list) {
      if (seen.has(node.href)) continue;
      seen.add(node.href);
      result.push({ ...node, children: walk(node.children) });
    }
    return result;
  };

  return walk(nodes);
}

/**
 * Заголовок и содержимое страницы.
 *
 * Confluence кладет заголовок в `#title-text`, а тело в `#main-content`.
 * Вокруг них разметка самой Confluence: хлебные крошки, панель сведений
 * о странице, подвал с датой выгрузки. Она в страницу не переносится.
 */
export function extractConfluencePage(html: string): ConfluencePageContent {
  if (!html) return { title: '', html: '' };
  const $ = load(html);

  const title =
    $('#title-text').text().trim() || $('title').text().trim() || '';

  const $content = $('#main-content');
  if ($content.length === 0) {
    return { title, html: '' };
  }

  // Разделы Confluence, не являющиеся содержимым страницы.
  //
  // `.expand-control` здесь намеренно нет: в нем лежит заголовок
  // раскрывающегося блока, и его удаление на этом шаге теряло подпись
  // еще до того, как форматтер макросов успевал ее прочитать.
  $content
    .find(
      '.pageSection.group, .page-metadata, .footer-body, ' +
        '#footer, .breadcrumb-section',
    )
    .remove();

  return { title, html: $content.html()?.trim() ?? '' };
}

/**
 * Заголовок страницы из имени файла.
 *
 * Confluence называет файлы `Заголовок_1234567.html`. Используется как
 * запасной вариант, когда в самой странице заголовка не нашлось.
 */
export function titleFromFileName(fileName: string): string {
  const base = fileName.replace(/\.html?$/i, '');
  return base.replace(/_\d+$/, '').replace(/_/g, ' ').trim();
}

/**
 * Вложения страницы из раздела «Attachments».
 *
 * Confluence Server кладет файлы под числовыми именами без расширения
 * (`attachments/65601/65602`), а настоящее имя и тип содержимого пишет
 * рядом со ссылкой. Без этого разбора вложение попадет в страницу под
 * числовым именем и без типа.
 *
 * Разбирать надо до вырезания служебных разделов: `extractConfluencePage`
 * удаляет `.pageSection.group`, внутри которого этот список и лежит.
 */
export function parseConfluenceAttachments(
  html: string,
): ConfluenceAttachment[] {
  if (!html) return [];
  const $ = load(html);

  const $section = $('.pageSection.group').filter((_, element) =>
    /attachment/i.test($(element).find('h2, .pageSectionHeader').text()),
  );
  const $scope = $section.length ? $section : $('.greybox').parent();
  if ($scope.length === 0) return [];

  const attachments: ConfluenceAttachment[] = [];
  const seen = new Set<string>();

  $scope.find('a[href]').each((_, element) => {
    const $link = $(element);
    const href = ($link.attr('href') ?? '').trim();
    const fileName = $link.text().trim();
    if (!href || !fileName) return;
    if (seen.has(href)) return;
    seen.add(href);

    attachments.push({
      href,
      fileName,
      mimeType: readMimeType($, $link),
    });
  });

  return attachments;
}

/**
 * Тип содержимого записан текстом сразу за ссылкой, в скобках.
 *
 * Когда его нет, отдается пустая строка: `processAttachments` определит тип
 * по расширению, а выдумывать `application/octet-stream` значило бы скрыть
 * настоящий тип файла с расширением.
 */
function readMimeType($: CheerioAPI, $link: any): string {
  let text = '';
  let node = $link[0]?.nextSibling;

  while (node && text.length < 120) {
    if (node.type === 'text') text += node.data ?? '';
    else if (node.name === 'br' || node.name === 'a') break;
    node = node.nextSibling;
  }

  const match = text.match(/\(([a-z0-9.+-]+\/[a-z0-9.+-]+)\)/i);
  return match ? match[1] : '';
}
