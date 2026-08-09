import { tool } from 'ai';
import { z } from 'zod';

/**
 * Инструменты агента.
 *
 * До этого инструментов не было вовсе: поле `tools` в вызов модели не
 * передавалось, потому что преобразование схем Zod v4 в JSON Schema ломалось.
 * Вместо инструментов агент писал в текст ответа разметку вида
 * `:::EDIT_PAGE:::`, которую сервер разбирал **после** завершения потока.
 *
 * Чем это ограничивало. Результат «инструмента» не возвращался в рассуждение
 * модели, второго прохода не было, а поиск инструментом не был вовсе: сервер
 * искал сам до вызова модели и лишь показывал поиск наружу парой
 * `tool_call`/`tool_result` ради интерфейса. Решение искать в интернете
 * принималось перебором слов в запросе, потому что спросить модель было
 * нечем.
 *
 * Совместимость проверена живым прогоном на `ai@6` и `zod@4`: инструмент
 * строится, схема преобразуется. Комментарий про несовместимость устарел.
 *
 * Здесь только описания и схемы. Выполнение остается в службе чата: у него
 * есть доступ к правам, страницам и переносу картинок, и разносить это по
 * двум местам значило бы завести два правила для одного действия.
 */

/** Сколько шагов рассуждения разрешено одному ответу. */
export const AGENT_MAX_STEPS = 8;

/**
 * Ссылка на страницу так, как ее дает человек.
 *
 * Внутреннего идентификатора человек не видит и передает адрес или slug, а
 * модель повторяет полученное. Приведение к идентификатору делает служба.
 */
const pageReference = z
  .string()
  .min(1)
  .describe(
    'Page identifier, slug id or page URL, exactly as it appeared in the conversation',
  );

export const searchPagesSchema = z.object({
  query: z.string().min(1).describe('What to look for in the wiki'),
});

export const searchWebSchema = z.object({
  queries: z
    .array(z.string().min(1))
    .min(1)
    .max(4)
    .describe(
      'Search phrasings. Several different phrasings find more than one repeated phrasing',
    ),
  images: z
    .boolean()
    .optional()
    .describe('Also look for images. Use when the answer needs pictures'),
});

export const createPageSchema = z.object({
  title: z.string().min(1).describe('Title of the new page'),
  content: z.string().describe('Page body in markdown'),
  spaceId: z
    .string()
    .optional()
    .describe('Space to create the page in. Omit to use the current space'),
  parentPageId: pageReference
    .optional()
    .describe('Parent page. Omit to create at the top level'),
});

export const editPageSchema = z.object({
  page: pageReference,
  content: z.string().describe('Markdown to write'),
  operation: z
    .enum(['append', 'replace', 'prepend'])
    .optional()
    .describe('How to apply the content. Defaults to append'),
});

export const updateTitleSchema = z.object({
  page: pageReference,
  title: z.string().min(1).describe('New title'),
});

type Executor<S extends z.ZodTypeAny> = (input: z.infer<S>) => Promise<unknown>;

/**
 * Собрать набор инструментов вокруг переданных исполнителей.
 *
 * Правка страниц предлагается только тогда, когда она разрешена: у чата без
 * права правки инструментов правки нет вовсе, и модель не может предложить
 * то, что все равно будет отвергнуто.
 */
export function buildAgentTools(opts: {
  searchPages: Executor<typeof searchPagesSchema>;
  searchWeb?: Executor<typeof searchWebSchema>;
  createPage?: Executor<typeof createPageSchema>;
  editPage?: Executor<typeof editPageSchema>;
  updateTitle?: Executor<typeof updateTitleSchema>;
}) {
  const tools: Record<string, unknown> = {
    search_pages: tool({
      description:
        'Search the wiki. Use it before answering anything about the workspace content.',
      inputSchema: searchPagesSchema,
      execute: opts.searchPages,
    }),
  };

  if (opts.searchWeb) {
    tools.search_web = tool({
      description:
        'Search the internet. Use it for facts that change over time, for anything the wiki does not cover, and when the answer needs images.',
      inputSchema: searchWebSchema,
      execute: opts.searchWeb,
    });
  }

  if (opts.createPage) {
    tools.create_page = tool({
      description: 'Create a new wiki page.',
      inputSchema: createPageSchema,
      execute: opts.createPage,
    });
  }

  if (opts.editPage) {
    tools.edit_page = tool({
      description: 'Write markdown into an existing wiki page.',
      inputSchema: editPageSchema,
      execute: opts.editPage,
    });
  }

  if (opts.updateTitle) {
    tools.update_title = tool({
      description: 'Rename an existing wiki page.',
      inputSchema: updateTitleSchema,
      execute: opts.updateTitle,
    });
  }

  return tools as any;
}
