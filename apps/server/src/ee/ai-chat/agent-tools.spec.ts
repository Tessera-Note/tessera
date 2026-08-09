import { asSchema } from '@ai-sdk/provider-utils';
import {
  AGENT_MAX_STEPS,
  buildAgentTools,
  createPageSchema,
  editPageSchema,
  searchPagesSchema,
  searchWebSchema,
  updateTitleSchema,
} from './agent-tools';

/**
 * Инструментов у агента не было вовсе: поле `tools` в вызов не передавалось,
 * потому что преобразование схем Zod v4 в JSON Schema ломалось. Вместо них
 * агент писал разметку в текст ответа, а сервер разбирал ее после завершения
 * потока, поэтому результат действия не возвращался в рассуждение модели.
 *
 * Проверяется то, на чем держится переход: схемы преобразуются, набор
 * собирается из того, что доступно, и лишнего в него не попадает.
 */
const SCHEMAS = [
  ['search_pages', searchPagesSchema],
  ['search_web', searchWebSchema],
  ['create_page', createPageSchema],
  ['edit_page', editPageSchema],
  ['update_title', updateTitleSchema],
] as const;

describe('Инструменты агента', () => {
  /**
   * Ровно то, из-за чего инструментов не было. Проверка живая: схема гоняется
   * через тот же преобразователь, которым пользуется SDK при вызове модели.
   */
  it.each(SCHEMAS)('схема %s преобразуется в JSON Schema', (_name, schema) => {
    const json = asSchema(schema as any).jsonSchema as any;

    expect(json.type).toBe('object');
    expect(Object.keys(json.properties ?? {}).length).toBeGreaterThan(0);
  });

  it('обязательные поля объявлены обязательными', () => {
    const search = asSchema(searchPagesSchema as any).jsonSchema as any;
    const edit = asSchema(editPageSchema as any).jsonSchema as any;

    expect(search.required).toEqual(['query']);
    expect(edit.required).toEqual(expect.arrayContaining(['page', 'content']));
    expect(edit.required).not.toContain('operation');
  });

  it('способ применения ограничен известными значениями', () => {
    const edit = asSchema(editPageSchema as any).jsonSchema as any;

    expect(edit.properties.operation.enum).toEqual([
      'append',
      'replace',
      'prepend',
    ]);
  });

  it('поиск по вики есть всегда', () => {
    const tools = buildAgentTools({ searchPages: async () => ({}) });

    expect(Object.keys(tools)).toEqual(['search_pages']);
  });

  /**
   * Поиска в интернете может не быть: служба не настроена. Предлагать модели
   * инструмент, который заведомо не отработает, значит получить ход впустую.
   */
  it('ненастроенный поиск в интернете в набор не попадает', () => {
    const tools = buildAgentTools({
      searchPages: async () => ({}),
      searchWeb: undefined,
      editPage: async () => ({}),
    });

    expect(Object.keys(tools).sort()).toEqual(['edit_page', 'search_pages']);
  });

  it('полный набор собирается целиком', () => {
    const noop = async () => ({});
    const tools = buildAgentTools({
      searchPages: noop,
      searchWeb: noop,
      createPage: noop,
      editPage: noop,
      updateTitle: noop,
    });

    expect(Object.keys(tools).sort()).toEqual([
      'create_page',
      'edit_page',
      'search_pages',
      'search_web',
      'update_title',
    ]);
  });

  it('у каждого инструмента есть описание и исполнитель', () => {
    const noop = async () => ({});
    const tools = buildAgentTools({
      searchPages: noop,
      searchWeb: noop,
      createPage: noop,
      editPage: noop,
      updateTitle: noop,
    });

    for (const [name, definition] of Object.entries<any>(tools)) {
      expect(typeof definition.description).toBe('string');
      expect(definition.description.length).toBeGreaterThan(10);
      expect(typeof definition.execute).toBe('function');
      expect(name).toMatch(/^[a-z_]+$/);
    }
  });

  /** Без предела на шаги разговор с инструментами может не закончиться. */
  it('число шагов ограничено', () => {
    expect(AGENT_MAX_STEPS).toBeGreaterThan(1);
    expect(AGENT_MAX_STEPS).toBeLessThanOrEqual(12);
  });
});
