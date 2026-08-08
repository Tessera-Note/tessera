import { getEmbedUrlAndProvider } from '@tessera/editor-ext';
import { Logger } from '@nestjs/common';
import * as path from 'path';
import { v7 } from 'uuid';
import { InsertableBacklink } from '@tessera/db/types/entity.types';
import { Cheerio, CheerioAPI, load } from 'cheerio';
import slugify from '@sindresorhus/slugify';
import { normalizeTableColumnWidths } from './table-utils';

// Check if text contains Unicode characters (for emojis/icons)
function isUnicodeCharacter(text: string): boolean {
  return text.length > 0 && text.codePointAt(0)! > 127; // Non-ASCII characters
}

export async function formatImportHtml(opts: {
  html: string;
  currentFilePath: string;
  filePathToPageMetaMap: Map<
    string,
    { id: string; title: string; slugId: string }
  >;
  creatorId: string;
  sourcePageId: string;
  workspaceId: string;
  pageDir?: string;
  attachmentCandidates?: string[];
  spaceSlug?: string;
}): Promise<{
  html: string;
  backlinks: InsertableBacklink[];
  pageIcon?: string;
}> {
  const {
    html,
    currentFilePath,
    filePathToPageMetaMap,
    creatorId,
    sourcePageId,
    workspaceId,
  } = opts;
  const $: CheerioAPI = load(html);
  const $root: Cheerio<any> = $.root();

  let pageIcon: string | null = null;
  // extract notion page icon
  const headerIconSpan = $root.find('header .page-header-icon .icon');

  if (headerIconSpan.length > 0) {
    const iconText = headerIconSpan.text().trim();
    if (iconText && isUnicodeCharacter(iconText)) {
      pageIcon = iconText;
    }
  }

  normalizeImportHtml($, $root);

  const backlinks = await rewriteInternalLinksToMentionHtml(
    $,
    $root,
    currentFilePath,
    filePathToPageMetaMap,
    creatorId,
    sourcePageId,
    workspaceId,
    opts.spaceSlug,
  );

  return {
    html: $root.html() || '',
    backlinks,
    pageIcon: pageIcon || undefined,
  };
}

/**
 * Contextless HTML cleanup shared by every import path.
 * - notionFormatter: no-op on non-Notion HTML (class-selector-based).
 * - xwikiFormatter: no-op on non-XWiki HTML (looks for #xwikicontent).
 * - defaultHtmlFormatter: table column widths + provider auto-embeds.
 *
 * Does NOT run rewriteInternalLinksToMentionHtml — that requires zip context.
 */
export function normalizeImportHtml(
  $: CheerioAPI,
  $root: Cheerio<any>,
): void {
  notionFormatter($, $root);
  confluenceFormatter($, $root);
  xwikiFormatter($, $root);
  defaultHtmlFormatter($, $root);
}

/**
 * Панели Confluence в типы выносок Tessera.
 *
 * Соответствие по смыслу, а не по имени: `warning` в Confluence это красная
 * панель ошибки, ей отвечает `danger`, а желтому `note` отвечает `note`.
 */
const CONFLUENCE_PANEL_TO_CALLOUT: Record<string, string> = {
  information: 'info',
  tip: 'success',
  note: 'note',
  warning: 'danger',
};

/** Цвета плашек статуса Confluence в цвета статуса Tessera. */
const CONFLUENCE_LOZENGE_TO_COLOR: Record<string, string> = {
  success: 'green',
  error: 'red',
  current: 'blue',
  complete: 'blue',
  moved: 'yellow',
};

/**
 * Макросы Confluence, у которых нет статического представления.
 *
 * Оглавление, отчеты и виджеты Jira при выгрузке отдают пустой контейнер:
 * их содержимое собирается на лету на стороне Confluence. Молча выбрасывать
 * такой блок нельзя, читатель перенесенной страницы не узнает, что тут
 * что-то было, поэтому вместо него ставится видимая отбивка.
 */
const MACRO_LABELS: Record<string, string> = {
  'toc-macro': 'оглавление',
  'client-side-toc-macro': 'оглавление',
  plugin_jira: 'виджет Jira',
  'jira-table': 'таблица Jira',
  'confluence-embedded-file-wrapper': 'встроенный файл',
};

/**
 * Разметка выгрузки Confluence в узлы редактора.
 *
 * Ничего не делает на разметке других источников: все выборки идут по
 * классам, которые ставит только Confluence.
 */
export function confluenceFormatter($: CheerioAPI, $root: Cheerio<any>) {
  convertConfluencePanels($, $root);
  convertConfluenceExpands($, $root);
  convertConfluenceCodePanels($, $root);
  convertConfluenceStatuses($, $root);
  markUnsupportedMacros($, $root);
}

function convertConfluencePanels($: CheerioAPI, $root: Cheerio<any>) {
  $root.find('.confluence-information-macro').each((_, element) => {
    const $panel = $(element);
    const classes = ($panel.attr('class') ?? '').split(/\s+/);

    let calloutType = 'info';
    for (const cls of classes) {
      const match = cls.match(/^confluence-information-macro-(\w+)$/);
      if (match && CONFLUENCE_PANEL_TO_CALLOUT[match[1]]) {
        calloutType = CONFLUENCE_PANEL_TO_CALLOUT[match[1]];
        break;
      }
    }

    const $body = $panel.find('.confluence-information-macro-body').first();
    const inner = ($body.length ? $body : $panel).html() ?? '';

    const $callout = $('<div>')
      .attr('data-type', 'callout')
      .attr('data-callout-type', calloutType)
      .html(inner);

    $panel.replaceWith($callout);
  });
}

function convertConfluenceExpands($: CheerioAPI, $root: Cheerio<any>) {
  $root.find('.expand-container').each((_, element) => {
    const $container = $(element);
    const title =
      $container.find('.expand-control-text').first().text().trim() ||
      'Подробности';
    const inner = $container.find('.expand-content').first().html() ?? '';

    const $details = $('<details>');
    $details.append($('<summary>').text(title));
    $details.append(
      $('<div>').attr('data-type', 'detailsContent').html(inner),
    );

    $container.replaceWith($details);
  });
}

/**
 * Панель кода в блок кода.
 *
 * Язык записан в параметрах подсветки (`brush: bash`). Заголовок панели
 * остается отдельным абзацем перед кодом: у блока кода своего заголовка нет,
 * а выбрасывать его значило бы потерять подпись.
 */
function convertConfluenceCodePanels($: CheerioAPI, $root: Cheerio<any>) {
  $root.find('div.code.panel').each((_, element) => {
    const $panel = $(element);
    const header = $panel.find('.codeHeader').first().text().trim();
    const $pre = $panel.find('pre').first();
    if ($pre.length === 0) return;

    const params = $pre.attr('data-syntaxhighlighter-params') ?? '';
    const brush = params.match(/brush:\s*([a-z0-9+#-]+)/i);
    const language = brush ? brush[1].toLowerCase() : null;

    const $code = $('<code>');
    if (language) $code.attr('class', `language-${language}`);
    $code.text($pre.text());

    const $newPre = $('<pre>').append($code);

    if (header) {
      const $header = $('<p>').append($('<strong>').text(header));
      $panel.replaceWith($header);
      $header.after($newPre);
    } else {
      $panel.replaceWith($newPre);
    }
  });
}

function convertConfluenceStatuses($: CheerioAPI, $root: Cheerio<any>) {
  $root.find('.status-macro').each((_, element) => {
    const $status = $(element);
    const classes = ($status.attr('class') ?? '').split(/\s+/);

    let color = 'gray';
    for (const cls of classes) {
      const match = cls.match(/^aui-lozenge-(\w+)$/);
      if (match && CONFLUENCE_LOZENGE_TO_COLOR[match[1]]) {
        color = CONFLUENCE_LOZENGE_TO_COLOR[match[1]];
        break;
      }
    }

    const $node = $('<span>')
      .attr('data-type', 'status')
      .attr('data-color', color)
      .text($status.text().trim());

    $status.replaceWith($node);
  });
}

/**
 * Видимая отбивка вместо непереносимого макроса.
 *
 * Ставится только там, где макрос не оставил текста: если содержимое
 * доехало, отбивка не нужна и только мешала бы.
 */
function markUnsupportedMacros($: CheerioAPI, $root: Cheerio<any>) {
  for (const [className, label] of Object.entries(MACRO_LABELS)) {
    $root.find(`.${className}`).each((_, element) => {
      const $macro = $(element);
      if ($macro.text().trim().length > 0) return;

      $macro.replaceWith(
        $('<p>').text(`[макрос Confluence не перенесен: ${label}]`),
      );
    });
  }
}

export function xwikiFormatter($: CheerioAPI, $root: Cheerio<any>) {
  const $content = $root.find('#xwikicontent');
  if ($content.length) {
    $root.children().remove();
    $root.append($content.contents());
  }
}

export function defaultHtmlFormatter($: CheerioAPI, $root: Cheerio<any>) {
  normalizeTableColumnWidths($, $root);

  $root.find('a[href]').each((_, el) => {
    const $el = $(el);
    const url = $el.attr('href')!;
    const { provider } = getEmbedUrlAndProvider(url);
    if (provider === 'iframe') return;

    const embed = `<div data-type=\"embed\" data-src=\"${url}\" data-provider=\"${provider}\" data-align=\"center\" data-width=\"640\" data-height=\"480\"></div>`;
    $el.replaceWith(embed);
  });

  $root.find('iframe[src]').each((_, el) => {
    const $el = $(el);
    const url = $el.attr('src')!;
    const { provider } = getEmbedUrlAndProvider(url);

    const embed = `<div data-type=\"embed\" data-src=\"${url}\" data-provider=\"${provider}\" data-align=\"center\" data-width=\"640\" data-height=\"480\"></div>`;
    $el.replaceWith(embed);
  });
}

const COLUMN_LAYOUTS = [
  '',
  '',
  'two_equal',
  'three_equal',
  'four_equal',
  'five_equal',
] as const;

export function notionFormatter($: CheerioAPI, $root: Cheerio<any>) {
  // remove page header icon and cover image
  $root.find('.page-header-icon').remove();
  $root.find('.page-cover-image').remove();

  // remove empty description paragraphs
  $root.find('p.page-description').each((_, el) => {
    if (!$(el).text().trim()) $(el).remove();
  });

  // columns
  $root.find('div.column-list').each((_, el) => {
    const $list = $(el);
    const $cols = $list.find('div.column');

    if ($cols.length <= 1) {
      $list.replaceWith($cols.html() || '');
      return;
    }

    const layout = COLUMN_LAYOUTS[$cols.length] ?? 'two_equal';
    let cells = '';
    $cols.each((_, col) => {
      const $col = $(col);
      $col.children('div[style*="display:contents"]').each((_, wrapper) => {
        $(wrapper).replaceWith($(wrapper).html() || '');
      });
      cells += `<div data-type="column">${$col.html()}</div>`;
    });

    $list.replaceWith(
      `<div data-type="columns" data-layout="${layout}">${cells}</div>`,
    );
  });

  // block math → mathBlock
  $root.find('figure.equation').each((_: any, fig: any) => {
    const $fig = $(fig);
    const tex = $fig
      .find('annotation[encoding="application/x-tex"]')
      .text()
      .trim();
    const $math = $('<div>')
      .attr('data-type', 'mathBlock')
      .attr('data-katex', 'true')
      .text(tex);
    $fig.replaceWith($math);
  });

  // inline math → mathInline
  $root.find('span.notion-text-equation-token').each((_, tok) => {
    const $tok = $(tok);
    const $prev = $tok.prev('style');
    if ($prev.length) $prev.remove();
    const tex = $tok
      .find('annotation[encoding="application/x-tex"]')
      .text()
      .trim();
    const $inline = $('<span>')
      .attr('data-type', 'mathInline')
      .attr('data-katex', 'true')
      .text(tex);
    $tok.replaceWith($inline);
  });

  // callouts
  $root
    .find('figure.callout')
    .get()
    .reverse()
    .forEach((fig) => {
      const $fig = $(fig);
      const $content = $fig.find('div').eq(1);
      if (!$content.length) return;
      const $wrapper = $('<div>')
        .attr('data-type', 'callout')
        .attr('data-callout-type', 'info');
      // @ts-ignore
      $content.children().each((_, child) => $wrapper.append(child));
      $fig.replaceWith($wrapper);
    });

  // to-do lists
  $root.find('ul.to-do-list').each((_, list) => {
    const $old = $(list);
    const $new = $('<ul>').attr('data-type', 'taskList');
    $old.find('li').each((_, li) => {
      const $li = $(li);
      const isChecked = $li.find('.checkbox.checkbox-on').length > 0;
      const text =
        $li
          .find('span.to-do-children-unchecked, span.to-do-children-checked')
          .first()
          .text()
          .trim() || '';
      const $taskItem = $('<li>')
        .attr('data-type', 'taskItem')
        .attr('data-checked', String(isChecked));
      const $label = $('<label>');
      const $input = $('<input>').attr('type', 'checkbox');
      if (isChecked) $input.attr('checked', '');
      $label.append($input, $('<span>'));
      const $container = $('<div>').append($('<p>').text(text));
      $taskItem.append($label, $container);
      $new.append($taskItem);
    });
    $old.replaceWith($new);
  });

  // toggle blocks
  $root
    .find('ul.toggle details')
    .get()
    .reverse()
    .forEach((det) => {
      const $det = $(det);
      const $li = $det.closest('li');
      if ($li.length) {
        $li.before($det);
        if (!$li.children().length) $li.remove();
      }
      const $ul = $det.closest('ul.toggle');
      if ($ul.length) {
        $ul.before($det);
        if (!$ul.children().length) $ul.remove();
      }
    });

  // bookmarks
  $root
    .find('figure')
    .filter((_, fig) => $(fig).find('a.bookmark.source').length > 0)
    .get()
    .reverse()
    .forEach((fig) => {
      const $fig = $(fig);
      const $link = $fig.find('a.bookmark.source').first();
      if (!$link.length) return;

      const href = $link.attr('href')!;
      const title = $link.find('.bookmark-title').text().trim() || href;

      const $newAnchor = $('<a>')
        .addClass('bookmark source')
        .attr('href', href)
        .append($('<div>').addClass('bookmark-info').text(title));

      $fig.replaceWith($newAnchor);
    });

  // remove user icons
  $root.find('span.user img.user-icon').remove();

  // remove toc
  $root.find('nav.table_of_contents').remove();
}

export function unwrapFromParagraph($: CheerioAPI, $node: Cheerio<any>) {
  // Keep track of processed wrappers to avoid infinite loops
  const processedWrappers = new Set<any>();

  let $wrapper = $node.closest('p, a');
  while ($wrapper.length) {
    const wrapperElement = $wrapper.get(0);

    // If we've already processed this wrapper, break to avoid infinite loop
    if (processedWrappers.has(wrapperElement)) {
      break;
    }

    processedWrappers.add(wrapperElement);

    // Check if the wrapper contains only whitespace and our target node
    const hasOnlyTargetNode =
      $wrapper.contents().filter((_, el) => {
        const $el = $(el);
        // Skip whitespace-only text nodes. NodeType 3 = text node
        if (el.nodeType === 3 && !$el.text().trim()) {
          return false;
        }
        // Return true if this is not our target node
        return !$el.is($node) && !$node.is($el);
      }).length === 0;

    if (hasOnlyTargetNode) {
      // Replace the wrapper entirely with our node
      $wrapper.replaceWith($node);
    } else {
      // Move the node to before the wrapper, preserving other content
      $wrapper.before($node);
    }

    // look again for any new wrapper around $node
    $wrapper = $node.closest('p, a');
  }
}

export async function rewriteInternalLinksToMentionHtml(
  $: CheerioAPI,
  $root: Cheerio<any>,
  currentFilePath: string,
  filePathToPageMetaMap: Map<
    string,
    { id: string; title: string; slugId: string }
  >,
  creatorId: string,
  sourcePageId: string,
  workspaceId: string,
  spaceSlug?: string,
): Promise<InsertableBacklink[]> {
  const normalize = (p: string) => p.replace(/\\/g, '/');
  const backlinks: InsertableBacklink[] = [];

  $root.find('a[href]').each((_, el) => {
    const $a = $(el);
    const raw = $a.attr('href')!;
    if (raw.startsWith('http') || raw.startsWith('/api/')) return;
    let decodedRaw = raw;
    try {
      decodedRaw = decodeURIComponent(raw);
    } catch (err) {
      Logger.warn(
        `URI malformed in page ${currentFilePath}: ${raw}. Falling back to raw path.`,
        'ImportFormatter',
      );
    }

    // Якорь отделяется до разрешения пути. Без этого ссылка на раздел
    // другой страницы (`Страница_102.html#razdel`) не находится в карте
    // и остается сырым путем из архива, то есть битой ссылкой.
    const hashIndex = decodedRaw.indexOf('#');
    const rawPath = hashIndex === -1 ? decodedRaw : decodedRaw.slice(0, hashIndex);
    const fragment = hashIndex === -1 ? '' : decodedRaw.slice(hashIndex);

    // Ссылка на якорь внутри той же страницы пути не имеет и трогать ее
    // не надо: она и так работает.
    if (!rawPath) return;

    const resolved = normalize(
      path.join(path.dirname(currentFilePath), rawPath),
    );
    const meta = filePathToPageMetaMap.get(resolved);
    if (!meta) return;

    const linkText = $a.text().trim();
    // Ссылка с якорем не превращается в упоминание, даже когда текст совпал
    // с заголовком: упоминание ведет на страницу целиком и якорь теряется.
    const titleMatch =
      !fragment &&
      (linkText === meta.title || linkText === meta.title?.trim());

    if (titleMatch) {
      const mentionId = v7();
      const $mention = $('<span>')
        .attr({
          'data-type': 'mention',
          'data-id': mentionId,
          'data-entity-type': 'page',
          'data-entity-id': meta.id,
          'data-label': meta.title,
          'data-slug-id': meta.slugId,
          'data-creator-id': creatorId,
        })
        .text(meta.title);
      $a.replaceWith($mention);
    } else {
      const titleSlug = slugify(meta.title?.substring(0, 70) || 'untitled');
      const pageSlug = `${titleSlug}-${meta.slugId}`;
      const internalHref = spaceSlug
        ? `/s/${spaceSlug}/p/${pageSlug}`
        : `/p/${pageSlug}`;

      $a.attr('href', `${internalHref}${fragment}`);
      $a.attr('data-internal', 'true');
    }

    backlinks.push({ sourcePageId, targetPageId: meta.id, workspaceId });
  });

  return backlinks;
}
