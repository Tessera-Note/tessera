/**
 * Таблица базы: отметка строк и групповое удаление.
 *
 * Проверяется то, чего не видят типы: отрезок по Shift, снятие отметки со
 * всего показанного и обязательный вопрос перед удалением. Удаление строки
 * необратимо, а кнопка стоит рядом с «Открыть» — без вопроса промах стоил бы
 * строки.
 */

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import BaseTable from './BaseTable.svelte';

let host: HTMLElement | null = null;
let component: Record<string, unknown> | null = null;

function property(id: string, name: string) {
  return { id, name, type: 'text', position: id, typeOptions: null, isPrimary: false };
}

const columns = [property('p1', 'Первое')];

function row(id: string, text: string) {
  return {
    id,
    pageId: 'pg1',
    cells: { p1: text },
    position: id,
    creatorId: null,
    lastUpdatedById: null,
    createdAt: null,
    updatedAt: null
  };
}

const rows = [row('r1', 'один'), row('r2', 'два'), row('r3', 'три')];

/**
 * Отрисовать таблицу вместе с владельцем отметок.
 *
 * Отметки живут снаружи, и без обратной записи второе нажатие видело бы
 * пустой выбор — то есть проверялась бы не таблица, а заглушка.
 */
function render(extra: Record<string, unknown> = {}): {
  box: HTMLElement;
  onselect: ReturnType<typeof vi.fn>;
} {
  host = document.createElement('div');
  document.body.appendChild(host);
  const onselect = vi.fn();
  const props = $state({
    columns,
    properties: columns,
    rows,
    config: {},
    context: {},
    people: [],
    editable: true,
    busy: null,
    selected: [] as string[],
    onwrite: () => {},
    onopen: () => {},
    ondeleteRow: () => {},
    ondeleteSelected: () => {},
    onconfig: () => {},
    onproperty: () => {},
    ondeleteProperty: () => {},
    ...extra,
    onselect: (rowIds: string[]) => {
      props.selected = rowIds;
      onselect(rowIds);
    }
  });
  component = mount(BaseTable, { target: host, props: props as never }) as Record<string, unknown>;
  flushSync();
  return { box: host, onselect };
}

/** Отметки строк. Отметка «всё» стоит в шапке и сюда не попадает. */
function boxes(box: HTMLElement): HTMLInputElement[] {
  return [...box.querySelectorAll('tbody input[type="checkbox"]')] as HTMLInputElement[];
}

function buttons(box: HTMLElement, text: string): HTMLElement[] {
  return [...box.querySelectorAll('button')].filter((one) => one.textContent?.trim() === text);
}

function shiftClick(mark: HTMLInputElement): void {
  mark.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }));
  flushSync();
}

afterEach(() => {
  if (component) void unmount(component);
  host?.remove();
  component = null;
  host = null;
});

describe('BaseTable', () => {
  it('отмечает строку', () => {
    const { box, onselect } = render();

    boxes(box)[1].click();

    expect(onselect).toHaveBeenCalledWith(['r2']);
  });

  it('повторное нажатие снимает отметку', () => {
    const { box, onselect } = render();

    boxes(box)[1].click();
    flushSync();
    boxes(box)[1].click();

    expect(onselect).toHaveBeenLastCalledWith([]);
  });

  it('Shift без опоры отмечает одну строку', () => {
    // Опора задаётся нажатием, а не отметкой извне: отмеченное могло прийти
    // от «отметить всё», и тянуть отрезок было бы не от чего.
    const { box, onselect } = render({ selected: ['r1'] });

    shiftClick(boxes(box)[2]);

    expect(onselect).toHaveBeenLastCalledWith(['r1', 'r3']);
  });

  it('Shift тянет отрезок от прошлого нажатия', () => {
    const { box, onselect } = render();

    boxes(box)[0].click();
    flushSync();
    shiftClick(boxes(box)[2]);

    // Первое нажатие ставит опору и отмечает r1, второе с Shift тянет отрезок
    // до r3. Судьба отрезка решается опорой: она отмечена, значит отмечается
    // весь отрезок.
    expect(onselect).toHaveBeenLastCalledWith(['r1', 'r2', 'r3']);
  });

  it('Shift от снятой опоры снимает отрезок', () => {
    const { box, onselect } = render({ selected: ['r1', 'r2', 'r3'] });

    // Первое нажатие снимает r1 и ставит её опорой, второе с Shift повторяет
    // её судьбу на всём отрезке.
    boxes(box)[0].click();
    flushSync();
    shiftClick(boxes(box)[2]);

    expect(onselect).toHaveBeenLastCalledWith([]);
  });

  it('шапка отмечает и снимает всё показанное', () => {
    const { box, onselect } = render();

    const all = () => box.querySelector('thead input[type="checkbox"]') as HTMLInputElement;
    all().click();
    flushSync();
    expect(onselect).toHaveBeenLastCalledWith(['r1', 'r2', 'r3']);

    all().click();
    expect(onselect).toHaveBeenLastCalledWith([]);
  });

  it('групповое удаление спрашивает и только потом удаляет', () => {
    const ondeleteSelected = vi.fn();
    const { box } = render({ ondeleteSelected, selected: ['r1', 'r2'] });

    const bar = box.querySelector('[data-component="BaseSelection"]') as HTMLElement;
    expect(bar.textContent).toContain('2 selected');

    buttons(bar, 'Delete')[0].click();
    flushSync();
    expect(ondeleteSelected).not.toHaveBeenCalled();
    expect(bar.textContent).toContain('Delete 2 rows?');

    buttons(bar, 'Confirm')[0].click();
    expect(ondeleteSelected).toHaveBeenCalledTimes(1);
  });

  it('без отметок полосы удаления нет', () => {
    const { box } = render();
    expect(box.querySelector('[data-component="BaseSelection"]')).toBeNull();
  });

  it('удаление строки спрашивает', () => {
    const ondeleteRow = vi.fn();
    const { box } = render({ ondeleteRow });

    const first = box.querySelector('tbody tr') as HTMLElement;
    buttons(first, 'Delete')[0].click();
    flushSync();
    expect(ondeleteRow).not.toHaveBeenCalled();

    buttons(first, 'Confirm')[0].click();
    expect(ondeleteRow).toHaveBeenCalledTimes(1);
    expect((ondeleteRow.mock.calls[0][0] as { id: string }).id).toBe('r1');
  });

  it('без обработчика правки шестерёнка свойства не рисуется', () => {
    // Устройство базы правят на её экране. Кнопка без обработчика молча
    // ничего не сохраняла бы, а закрытие окна человек читает как запись.
    const { box } = render({ onproperty: undefined, ondeleteProperty: undefined });
    expect(box.querySelector('thead [aria-label="Edit property"]')).toBeNull();
  });

  it('с обработчиком правки шестерёнка есть', () => {
    const { box } = render();
    expect(box.querySelector('thead [aria-label="Edit property"]')).not.toBeNull();
  });

  it('смотрящему отметки не показываются', () => {
    // Отмечать нечего: единственное групповое действие — удаление, а его он
    // не может.
    const { box } = render({ editable: false });
    expect(boxes(box)).toHaveLength(0);
    expect(box.querySelector('thead input[type="checkbox"]')).toBeNull();
  });
});
