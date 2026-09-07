/**
 * Доска.
 *
 * Проверяется состав карточки: без выбора — первые три свойства, с выбором —
 * ровно выбранные. У базы с двадцатью свойствами «первые три» это три
 * случайных, и важное на доску не попадало вовсе.
 */

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import BaseKanban from './BaseKanban.svelte';

let host: HTMLElement | null = null;
let component: Record<string, unknown> | null = null;

function property(id: string, name: string, type = 'text') {
  return { id, name, type, position: id, typeOptions: null, isPrimary: false };
}

const status = {
  id: 'st',
  name: 'Состояние',
  type: 'select',
  position: 'a',
  typeOptions: { choices: [{ id: 'c1', name: 'В работе' }] },
  isPrimary: false
};

const properties = [
  status,
  property('p1', 'Первое'),
  property('p2', 'Второе'),
  property('p3', 'Третье'),
  property('p4', 'Четвёртое')
];

const rows = [
  {
    id: 'r1',
    pageId: 'pg1',
    cells: { st: 'c1', p1: 'один', p2: 'два', p3: 'три', p4: 'четыре' },
    position: 'a',
    creatorId: null,
    lastUpdatedById: null,
    createdAt: null,
    updatedAt: null
  }
];

function render(props: Record<string, unknown> = {}): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(BaseKanban, {
    target: host,
    props: {
      properties,
      columns: properties,
      rows,
      config: { groupByPropertyId: 'st' },
      context: {},
      editable: true,
      onopen: () => {},
      onmove: () => {},
      onconfig: () => {},
      ...props
    } as never
  }) as Record<string, unknown>;
  flushSync();
  return host;
}

function cardText(box: HTMLElement): string {
  return (box.querySelector('[data-component="BaseKanban"] button')?.textContent ?? '').trim();
}

afterEach(() => {
  if (component) void unmount(component);
  host?.remove();
  component = null;
  host = null;
});

describe('BaseKanban', () => {
  it('без выбора показывает первые три свойства', () => {
    const box = render();
    const card = cardText(box);
    expect(card).toContain('один');
    expect(card).toContain('два');
    expect(card).toContain('три');
    expect(card).not.toContain('четыре');
  });

  it('показывает ровно выбранное', () => {
    const box = render({ config: { groupByPropertyId: 'st', cardPropertyIds: ['p4'] } });
    const card = cardText(box);
    expect(card).toContain('четыре');
    expect(card).not.toContain('один');
  });

  it('свойство-столбец на карточке не показывается', () => {
    // Оно и есть столбец: второй раз называть его на каждой карточке незачем.
    const box = render({ config: { groupByPropertyId: 'st', cardPropertyIds: ['st', 'p1'] } });
    expect(cardText(box)).not.toContain('В работе');
  });

  it('выбор сохраняется в настройках представления', () => {
    const onconfig = vi.fn();
    const box = render({ onconfig });

    const boxes = [...box.querySelectorAll('button')];
    boxes.find((one) => one.textContent?.trim() === 'Card properties')?.click();
    flushSync();

    const fourth = [...box.querySelectorAll('label')].find((one) =>
      (one.textContent ?? '').includes('Четвёртое')
    );
    (fourth?.querySelector('input') as HTMLInputElement).click();

    expect(onconfig).toHaveBeenCalled();
    const saved = onconfig.mock.calls[0][0] as { cardPropertyIds: string[] };
    // Порядок берётся у самих свойств, а не у порядка нажатий.
    expect(saved.cardPropertyIds).toEqual(['p1', 'p2', 'p3', 'p4']);
  });

  it('читателю выбор не предлагается', () => {
    const box = render({ editable: false });
    const labels = [...box.querySelectorAll('button')].map((one) => one.textContent?.trim());
    expect(labels).not.toContain('Card properties');
  });
});
