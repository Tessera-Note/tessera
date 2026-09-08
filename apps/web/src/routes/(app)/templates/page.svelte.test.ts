/**
 * Экран шаблонов.
 *
 * Проверяется то, что различает людей и необратимые действия: кнопка заведения
 * показывается по тому же правилу, какое проверяет сервер; правка и удаление —
 * только тому, кто ими вправе пользоваться; удаление спрашивает.
 */

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { calls } from '../../../test-stubs/app-navigation';

const deleteTemplate = vi.fn();
const useTemplate = vi.fn();
const createTemplate = vi.fn();
const listTemplates = vi.fn();
vi.mock('$lib/features/template/services/templates', () => ({
  deleteTemplate: (...args: unknown[]) => deleteTemplate(...args),
  useTemplate: (...args: unknown[]) => useTemplate(...args),
  createTemplate: (...args: unknown[]) => createTemplate(...args),
  templateInfo: () => Promise.resolve({ id: 't1', title: 'Отчёт', content: null }),
  listTemplates: (...args: unknown[]) => listTemplates(...args)
}));

const addFavoriteTemplate = vi.fn();
const removeFavoriteTemplate = vi.fn();
vi.mock('$lib/features/page/services/favorites', () => ({
  addFavoriteTemplate: (...args: unknown[]) => addFavoriteTemplate(...args),
  removeFavoriteTemplate: (...args: unknown[]) => removeFavoriteTemplate(...args)
}));

// Выбор родителя ищет страницы: сам поиск проверяется у своего компонента.
vi.mock('$lib/features/search/services/search', () => ({
  searchPages: () => Promise.resolve([])
}));

// Просмотр документа тянет за собой редактор целиком: экрану шаблонов он
// нужен только внутри предпросмотра, который здесь не открывается.
vi.mock('$lib/features/editor/DocumentView.svelte', async () => ({
  default: (await import('$lib/components/ui/Notice.svelte')).default
}));

const { default: TemplatesPage } = await import('./+page.svelte');

let host: HTMLElement | null = null;
let component: Record<string, unknown> | null = null;

const spaces = [
  { id: 's1', name: 'Общее', slug: 'general', description: null, role: 'admin' },
  { id: 's2', name: 'Соседнее', slug: 'other', description: null, role: 'member' }
];

const templates = [
  {
    id: 't1',
    title: 'Отчёт',
    description: null,
    icon: null,
    spaceId: 's1',
    creatorId: null,
    createdAt: '',
    updatedAt: ''
  },
  {
    id: 't2',
    title: 'Общий',
    description: null,
    icon: null,
    spaceId: null,
    creatorId: null,
    createdAt: '',
    updatedAt: ''
  }
];

function render(session: Record<string, unknown>, over: Record<string, unknown> = {}): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(TemplatesPage, {
    target: host,
    props: {
      data: {
        templates,
        spaces,
        session,
        spaceId: undefined,
        nextCursor: null,
        favorites: [],
        ...over
      } as never
    }
  }) as Record<string, unknown>;
  flushSync();
  return host;
}

function member(workspace: Record<string, unknown> = {}) {
  return { user: { id: 'u1', role: 'member' }, workspace };
}

function owner() {
  return { user: { id: 'u1', role: 'owner' }, workspace: {} };
}

function buttons(box: HTMLElement): string[] {
  return [...box.querySelectorAll('button')].map((one) => (one.textContent ?? '').trim());
}

function titles(box: HTMLElement): string[] {
  return [...box.querySelectorAll('[data-component="TemplateList"] li')].map((one) =>
    (one.querySelector('p')?.textContent ?? '').trim()
  );
}

beforeEach(() => {
  deleteTemplate.mockReset();
  deleteTemplate.mockResolvedValue({ success: true });
  useTemplate.mockReset();
  useTemplate.mockResolvedValue({ id: 'p1', slugId: 'abc', spaceId: 's1' });
  createTemplate.mockReset();
  createTemplate.mockResolvedValue({ id: 't3' });
});

afterEach(() => {
  if (component) void unmount(component);
  host?.remove();
  component = null;
  host = null;
});

describe('Экран шаблонов', () => {
  it('не предлагает завести шаблон тому, кому сервер откажет', () => {
    const box = render(member());
    expect(buttons(box)).not.toContain('New template');
  });

  it('предлагает завести, когда признак включён', () => {
    const box = render(member({ allowMemberTemplates: true }));
    expect(buttons(box)).toContain('New template');
  });

  it('предлагает завести администратору и без признака', () => {
    const box = render(owner());
    expect(buttons(box)).toContain('New template');
  });

  it('не показывает участнику правку и удаление', () => {
    const box = render(member({ allowMemberTemplates: true }));
    expect(buttons(box)).not.toContain('Delete');
    expect(box.querySelector('a[href="/templates/t1"]')).toBeNull();
  });

  it('спрашивает перед удалением', async () => {
    const box = render(owner());
    const remove = [...box.querySelectorAll('button')].find(
      (one) => (one.textContent ?? '').trim() === 'Delete'
    );
    remove?.click();
    flushSync();

    // Первое нажатие только задаёт вопрос: удаление необратимо.
    expect(deleteTemplate).not.toHaveBeenCalled();
    expect(buttons(box)).toContain('Confirm');

    const confirm = [...box.querySelectorAll('button')].find(
      (one) => (one.textContent ?? '').trim() === 'Confirm'
    );
    confirm?.click();
    await Promise.resolve();
    expect(deleteTemplate).toHaveBeenCalledWith('t1');
  });

  it('отбирает по области запросом, а не на месте', () => {
    // Выдача постраничная: отобранная на месте страница выходила бы пустой при
    // том, что подходящие шаблоны есть дальше.
    calls.goto.length = 0;
    const box = render(owner());
    expect(titles(box)).toHaveLength(2);

    const select = box.querySelector('select') as HTMLSelectElement;
    select.value = 's1';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    flushSync();

    expect(calls.goto).toContain('/templates?spaceId=s1');
  });

  it('догружает продолжение перечня', async () => {
    listTemplates.mockResolvedValue({
      items: [
        {
          id: 't3',
          title: 'Третий',
          description: null,
          icon: null,
          spaceId: null,
          creatorId: null,
          createdAt: '',
          updatedAt: ''
        }
      ],
      meta: { nextCursor: null }
    });
    const box = render(owner(), { nextCursor: 'дальше' });

    const more = [...box.querySelectorAll('button')].find(
      (one) => (one.textContent ?? '').trim() === 'Load more'
    );
    more?.click();
    for (let step = 0; step < 4; step += 1) await Promise.resolve();
    flushSync();

    expect(listTemplates).toHaveBeenCalledWith({ spaceId: undefined, cursor: 'дальше' });
    expect(titles(box)).toContain('Третий');
  });

  it('без продолжения кнопки нет', () => {
    const box = render(owner());
    expect(buttons(box)).not.toContain('Load more');
  });

  it('спрашивает назначение у шаблона рабочего пространства', async () => {
    const box = render(owner());
    const rows = [...box.querySelectorAll('[data-component="TemplateList"] li')];
    const shared = rows[1];
    const use = [...shared.querySelectorAll('button')].find(
      (one) => (one.textContent ?? '').trim() === 'Use template'
    );
    use?.click();
    flushSync();

    // Своей области у такого шаблона нет, и страница обязана появиться в
    // какой-то: без вопроса выбор делался бы за человека.
    expect(useTemplate).not.toHaveBeenCalled();
    expect((shared.textContent ?? '').includes('Choose destination')).toBe(true);
  });

  it('у шаблона пространства подставляет его область', () => {
    // Спрашивается всё равно: внутри пространства страница может быть и
    // корневой, и вложенной, а без вопроса она всегда падала в корень.
    const box = render(owner());
    const rows = [...box.querySelectorAll('[data-component="TemplateList"] li')];
    const own = rows[0];
    const use = [...own.querySelectorAll('button')].find(
      (one) => (one.textContent ?? '').trim() === 'Use template'
    );
    use?.click();
    flushSync();

    expect(useTemplate).not.toHaveBeenCalled();
    const select = own.querySelector('select') as HTMLSelectElement;
    expect(select.value).toBe('s1');
    expect((own.textContent ?? '').includes('Parent page')).toBe(true);
  });

  it('заводит страницу в корне, когда родитель не выбран', async () => {
    const box = render(owner());
    const own = [...box.querySelectorAll('[data-component="TemplateList"] li')][0];
    [...own.querySelectorAll('button')]
      .find((one) => (one.textContent ?? '').trim() === 'Use template')
      ?.click();
    flushSync();

    [...own.querySelectorAll('button')]
      .find((one) => (one.textContent ?? '').trim() === 'Create page')
      ?.click();
    await Promise.resolve();

    expect(useTemplate).toHaveBeenCalledWith({
      templateId: 't1',
      spaceId: 's1',
      parentPageId: undefined
    });
  });

  it('отмеченные шаблоны идут первыми', () => {
    // Перечень длинный, и часто применяемый иначе ищется глазами наравне с
    // заведённым однажды.
    const box = render(owner(), { favorites: [{ templateId: 't2' }] });
    expect(titles(box)).toEqual(['Общий', 'Отчёт']);
  });

  it('отметка снимается тем же нажатием', () => {
    const box = render(owner(), { favorites: [{ templateId: 't1' }] });
    const own = [...box.querySelectorAll('[data-component="TemplateList"] li')].find((one) =>
      (one.textContent ?? '').includes('Отчёт')
    ) as HTMLElement;

    const star = [...own.querySelectorAll('button')].find(
      (one) => one.getAttribute('aria-label') === 'Remove from favorites'
    );
    star?.click();

    expect(removeFavoriteTemplate).toHaveBeenCalledWith('t1');
  });
});
