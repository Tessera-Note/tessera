/**
 * Ответ агента на экран.
 *
 * Модель отвечает разметкой Markdown: ссылки, списки, таблицы, врезки, блоки
 * кода. Показ обычным текстом выводил их как есть — человек читал
 * `- [Meteofor](https://…)` вместо ссылки, и чем полезнее был ответ, тем хуже
 * он выглядел.
 *
 * Порядок тот же, что в v1 (`ee/ai-chat/components/chat-message.tsx`):
 * `markdownToHtml` из общего пакета, затем очистка. Очистка обязательна и не
 * является перестраховкой: разметку сочиняет модель по найденному в интернете,
 * то есть по чужому тексту.
 *
 * Очиститель требует DOM, поэтому экран разговора отрисовывается в браузере
 * (`ssr = false` в `+page.server.ts`). Это не обход ограничения: разговор
 * идёт потоком по SSE и без сценариев не работает вовсе.
 */

import DOMPurify from 'dompurify';
import { markdownToHtml } from '@tessera/editor-ext';

/**
 * Адрес страницы внутри рабочего пространства.
 *
 * Модель знает адрес вида `/s/{space}/p/{slug}`, но регулярно оборачивает его
 * в выдуманный хост: `https://s/...`, `https://example.com/s/...`, `//s/...`.
 * Такая ссылка уводит человека наружу вместо перехода к странице.
 */
const PAGE_PATH_RE = /\/s\/[^/?#]+\/p\/[^/?#]+/;

/**
 * Что разрешено в ответе.
 *
 * Перечень, а не запрет отдельных вещей: список разрешённого не расширяется
 * сам собой, когда в разметке появляется новый тег.
 */
const ALLOWED_TAGS = [
  'p',
  'br',
  'strong',
  'em',
  's',
  'del',
  'code',
  'pre',
  'blockquote',
  'a',
  'ul',
  'ol',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td'
];

/**
 * Свой очиститель, а не общий: к нему привязана правка ссылок.
 *
 * Создаётся при первом обращении, потому что модуль читается и на сервере —
 * при сборке маршрута, — а DOM там отсутствует.
 */
let cleaner: ReturnType<typeof DOMPurify> | null = null;

function sanitizer() {
  if (cleaner) return cleaner;

  const made = DOMPurify();
  made.addHook('afterSanitizeAttributes', (node: Element) => {
    if (node.tagName !== 'A') return;
    const href = node.getAttribute('href') ?? '';

    const inside = href.match(PAGE_PATH_RE);
    if (inside) {
      // Свой адрес: хост отбрасывается, переход остаётся внутренним.
      node.setAttribute('href', inside[0]);
      node.removeAttribute('target');
      node.removeAttribute('rel');
      return;
    }

    if (href.startsWith('http://') || href.startsWith('https://')) {
      // Ссылка наружу открывается отдельно: уводить человека из разговора
      // значит терять сам разговор.
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });

  cleaner = made;
  return made;
}

/** Разметка ответа, пригодная к показу. */
export function answerHtml(markdown: string): string {
  const rendered = markdownToHtml(markdown ?? '');
  // `markdownToHtml` объявлен как строка либо обещание: у общего пакета есть
  // разбор, требующий ожидания. Наш путь синхронный, и обещание сюда не
  // приходит — но полагаться на это молча нельзя.
  if (typeof rendered !== 'string') return '';

  return sanitizer().sanitize(rendered, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ['href', 'title', 'class', 'data-type', 'data-checked'],
    ADD_ATTR: ['target', 'rel']
  });
}
