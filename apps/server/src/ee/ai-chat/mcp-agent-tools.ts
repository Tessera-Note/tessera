import { jsonSchema, tool } from 'ai';
import { User, Workspace } from '@tessera/db/types/entity.types';

/**
 * Инструменты чата, взятые у MCP.
 *
 * У агента чата было пять инструментов: поиск, веб-поиск, создание, правка и
 * переименование. У MCP того же приложения их шестьдесят пять, и среди них уже
 * есть список страниц, перенос, удаление с корзиной, метки, шаблоны и история.
 * Заводить рядом второй набор значило бы держать две модели доступа вместо
 * одной: инструменты MCP проходят проверку прав и пишут в журнал аудита.
 *
 * Поэтому чат берет их через мост. Определения и схемы не дублируются, они
 * приходят из самого MCP.
 */

/**
 * Что инструмент делает с данными.
 *
 * `read` ничего не меняет. `write` добавляет и правит обратимо: содержимое
 * страницы переживает правку в истории версий, метку можно снять, дубль
 * удалить. `destructive` меняет то, что вернуть трудно или нечем.
 *
 * Разделение нужно ради подтверждения: необратимое действие агент не выполняет
 * сам, он показывает план и ждет явного согласия. Пока подтверждения нет,
 * необратимые инструменты не отдаются агенту вовсе.
 */
export type ToolRisk = 'read' | 'write' | 'destructive';

export const AGENT_TOOL_POLICY: Record<string, ToolRisk> = {
  // Обзор структуры. Ровно этого агенту и не хватало: без списка страниц он
  // отвечал, что поиск ничего не вернул, хотя страницы в вики были.
  list_spaces: 'read',
  list_pages: 'read',
  list_recent_pages: 'read',
  get_page: 'read',
  get_page_breadcrumbs: 'read',
  get_page_backlinks: 'read',
  search_workspace: 'read',
  search_everything: 'read',
  search_semantic: 'read',
  list_trash: 'read',

  // Метки.
  list_labels: 'read',
  list_page_labels: 'read',
  find_pages_by_label: 'read',
  add_page_labels: 'write',
  remove_page_label: 'write',

  // Шаблоны.
  list_templates: 'read',
  get_template: 'read',
  use_template: 'write',
  create_template: 'write',

  // История версий.
  list_page_history: 'read',
  get_page_version: 'read',

  // Комментарии.
  list_page_comments: 'read',
  get_comment: 'read',
  create_comment: 'write',

  // Создание и размножение: добавляет, ничего не теряя.
  duplicate_page: 'write',

  // Необратимое. Перенос меняет место страницы и ее адрес, удаление уносит
  // ветку в корзину вместе с потомками, восстановление возвращает не всегда
  // туда же.
  move_page: 'destructive',
  move_page_to_space: 'destructive',
  delete_page: 'destructive',
  restore_page: 'destructive',
  delete_comment: 'destructive',
  delete_template: 'destructive',
};

interface McpBridge {
  listAgentTools(): Array<{
    name: string;
    description: string;
    inputSchema: unknown;
  }>;
  runAgentTool(
    name: string,
    args: unknown,
    user: User,
    workspace: Workspace,
  ): Promise<unknown>;
}

/** Шаг плана: что агент собирается сделать, если человек согласится. */
export interface PlannedStep {
  tool: string;
  args: unknown;
}

/**
 * Собрать инструменты чата из определений MCP.
 *
 * `allow` перечисляет допустимые степени риска. Необратимые инструменты либо не
 * отдаются вовсе, либо отдаются вместе с `plan` и тогда не выполняются, а
 * записываются. Отдать необратимый инструмент без того и другого значило бы
 * дать агенту удалять без спроса.
 */
export function buildMcpAgentTools(opts: {
  mcp: McpBridge;
  user: User;
  workspace: Workspace;
  allow: ToolRisk[];
  /**
   * Куда складывать необратимые шаги вместо выполнения.
   *
   * Передан — необратимый инструмент ничего не делает, он записывает
   * намерение и отвечает агенту, что шаг занесен в план. Тогда агент может
   * продолжать рассуждение и набрать весь план за один ход мысли, а человек
   * увидит его целиком, а не по одному действию.
   *
   * Не передан — необратимые инструменты выполняются как обычные. Это режим
   * для вызывающего, который уже получил согласие: подтверждение исполняет
   * записанный план тем же путем.
   */
  plan?: PlannedStep[];
  onError?: (name: string, err: unknown) => void;
}): Record<string, unknown> {
  const allowed = new Set(opts.allow);
  const tools: Record<string, unknown> = {};

  for (const definition of opts.mcp.listAgentTools()) {
    const risk = AGENT_TOOL_POLICY[definition.name];
    if (!risk || !allowed.has(risk)) continue;

    tools[definition.name] = tool({
      description: definition.description,
      // Схема берется у MCP как есть: дублировать ее на стороне чата значило бы
      // завести второе описание того же входа, и они разошлись бы.
      inputSchema: jsonSchema(definition.inputSchema as any),
      execute: async (args: unknown) => {
        if (risk === 'destructive' && opts.plan) {
          opts.plan.push({ tool: definition.name, args });
          return {
            status: 'planned',
            note: 'Recorded in the plan. It runs only after the user confirms.',
          };
        }

        try {
          return await opts.mcp.runAgentTool(
            definition.name,
            args,
            opts.user,
            opts.workspace,
          );
        } catch (err) {
          // Отказ инструмента не должен ронять разговор: агент получает
          // причину и может выбрать другой путь.
          opts.onError?.(definition.name, err);
          return {
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    });
  }

  return tools;
}
