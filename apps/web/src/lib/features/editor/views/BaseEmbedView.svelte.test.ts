/**
 * Встроенная база.
 *
 * Показывается и правится таблицей, как её собственный экран: ссылкой вместо
 * неё страница теряет то, ради чего базу в неё вставили, а уход на отдельный
 * экран ради одной ячейки — то же самое другими словами. Правка снимается
 * дважды: правом самой базы и режимом чтения страницы.
 */

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const baseInfo = vi.fn();
const baseRows = vi.fn();
const expandPages = vi.fn();
const createRow = vi.fn();
const updateRow = vi.fn();
const deleteRow = vi.fn();
const updateView = vi.fn();
vi.mock('$lib/features/base/services/bases', () => ({
  baseInfo: (...args: unknown[]) => baseInfo(...args),
  baseRows: (...args: unknown[]) => baseRows(...args),
  expandPages: (...args: unknown[]) => expandPages(...args),
  createRow: (...args: unknown[]) => createRow(...args),
  updateRow: (...args: unknown[]) => updateRow(...args),
  deleteRow: (...args: unknown[]) => deleteRow(...args),
  updateView: (...args: unknown[]) => updateView(...args)
}));

const { default: BaseEmbedView } = await import('./BaseEmbedView.svelte');

let host: HTMLElement | null = null;
let component: Record<string, unknown> | null = null;

const properties = [
  {
    id: 'p1',
    name: 'Название',
    type: 'title',
    position: 'a',
    typeOptions: null,
    isPrimary: true
  },
  { id: 'p2', name: 'Кто', type: 'text', position: 'b', typeOptions: null, isPrimary: false }
];

function render(
  attributes: Record<string, unknown>,
  extra: Record<string, unknown> = {}
): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(BaseEmbedView, {
    target: host,
    props: { attributes, selected: false, editable: true, ...extra } as never
  }) as Record<string, unknown>;
  flushSync();
  return host;
}

/** Дать загрузке дойти до показа: содержимое приходит обещаниями. */
async function settle(): Promise<void> {
  for (let step = 0; step < 6; step += 1) await Promise.resolve();
  flushSync();
}

beforeEach(() => {
  baseInfo.mockReset();
  baseRows.mockReset();
  expandPages.mockReset();
  createRow.mockReset();
  createRow.mockResolvedValue({});
  updateRow.mockReset();
  updateRow.mockResolvedValue({});
  deleteRow.mockReset();
  deleteRow.mockResolvedValue({});
  updateView.mockReset();
  updateView.mockResolvedValue({});
  baseInfo.mockResolvedValue({
    id: 'b1',
    slugId: 'b1',
    name: 'Проекты',
    icon: null,
    spaceId: 's1',
    baseSchemaVersion: 1,
    properties,
    views: [{ id: 'v1', name: 'Таблица', type: 'table', position: 'a', config: {} }],
    permissions: { canEdit: true, canView: true }
  });
  baseRows.mockResolvedValue({
    items: [
      {
        id: 'r1',
        pageId: 'pg1',
        cells: { p1: 'Первая строка', p2: 'Ответственный' },
        position: 'a',
        creatorId: null,
        lastUpdatedById: null,
        createdAt: null,
        updatedAt: null
      }
    ],
    nextCursor: null,
    references: { users: [] }
  });
});

afterEach(() => {
  if (component) void unmount(component);
  host?.remove();
  component = null;
  host = null;
});

describe('BaseEmbedView', () => {
  it('показывает строки базы, а не одну ссылку', async () => {
    const box = render({ pageId: 'b1' });
    await settle();

    // У правящего ячейка это поле ввода, и её содержимое лежит в значении.
    expect(box.querySelector('table')).not.toBeNull();
    const values = [...box.querySelectorAll('input')].map((one) => one.value);
    expect(values).toContain('Первая строка');
    expect(values).toContain('Ответственный');
  });

  it('ведёт на экран базы', async () => {
    const box = render({ pageId: 'b1' });
    await settle();

    const link = box.querySelector('a');
    expect(link?.getAttribute('href')).toBe('/base/b1');
    expect((link?.textContent ?? '').trim()).toBe('Проекты');
  });

  it('правится на месте, когда право есть', async () => {
    const box = render({ pageId: 'b1' });
    await settle();

    const add = [...box.querySelectorAll('button')].find(
      (one) => one.textContent?.trim() === 'New row'
    );
    add?.click();
    await settle();

    expect(createRow).toHaveBeenCalledWith('b1');
  });

  it('без права правки не предлагает ни строки, ни настроек', async () => {
    // Сервер проверит права снова, но кнопка, которая всегда отказывает,
    // здесь не нужна.
    baseInfo.mockResolvedValue({
      id: 'b1',
      slugId: 'b1',
      name: 'Проекты',
      icon: null,
      spaceId: 's1',
      baseSchemaVersion: 1,
      properties,
      views: [{ id: 'v1', name: 'Таблица', type: 'table', position: 'a', config: {} }],
      permissions: { canEdit: false, canView: true }
    });
    const box = render({ pageId: 'b1' });
    await settle();

    const labels = [...box.querySelectorAll('button')].map((one) => one.textContent?.trim());
    expect(labels).not.toContain('New row');
    expect((box.textContent ?? '').includes('Columns')).toBe(false);
  });

  it('на странице, открытой на чтение, не правится', async () => {
    // Право у базы есть, но страница показана на чтение: правка через неё
    // обошла бы переключатель режима.
    const box = render({ pageId: 'b1' }, { editable: false });
    await settle();

    const labels = [...box.querySelectorAll('button')].map((one) => one.textContent?.trim());
    expect(labels).not.toContain('New row');
  });

  it('показывает отказ, а не пустоту', async () => {
    baseInfo.mockRejectedValue(new Error('нет связи'));
    const box = render({ pageId: 'b1' });
    await settle();

    expect(box.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('без базы ничего не грузит', () => {
    render({});
    expect(baseInfo).not.toHaveBeenCalled();
  });
});
