/**
 * Карточка вложения.
 *
 * Проверяется, что человек видит имя, размер и состояние загрузки, что
 * встраивание PDF заменяет узел, а не дописывает второй, и что отметка «не
 * найдётся поиском» приходит с сервера, а не выводится из имени файла.
 */

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AttachmentView from './AttachmentView.svelte';
import * as attachments from '$lib/features/page/services/attachments';

let host: HTMLElement | null = null;
let component: Record<string, unknown> | null = null;

type World = { inserted: unknown[] };

function render(
  attributes: Record<string, unknown>,
  options: { editable?: boolean; selected?: boolean } = {}
): World {
  const world: World = { inserted: [] };
  const chain = () => {
    const link = {
      insertContentAt: (range: unknown, content: unknown) => {
        world.inserted.push({ range, content });
        return link;
      },
      run: () => true
    };
    return link;
  };

  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(AttachmentView, {
    target: host,
    props: {
      node: { nodeSize: 1 },
      attributes,
      selected: options.selected ?? false,
      editable: options.editable ?? true,
      editor: { chain },
      updateAttributes: () => {},
      position: () => 4
    } as never
  }) as Record<string, unknown>;
  flushSync();
  return world;
}

function card(): HTMLElement {
  const found = host?.querySelector<HTMLElement>('[data-component="AttachmentView"]');
  if (!found) throw new Error('карточки нет');
  return found;
}

beforeEach(() => {
  vi.spyOn(attachments, 'attachmentInfo').mockResolvedValue({
    id: 'a1',
    fileName: 'note.txt',
    fileSize: 2048,
    mimeType: 'text/plain',
    pageId: 'p1',
    updatedAt: null,
    indexStatus: 'indexed'
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (component) void unmount(component);
  host?.remove();
  component = null;
  host = null;
});

describe('AttachmentView', () => {
  it('показывает имя и размер', () => {
    render({ url: '/files/a1/note.txt', name: 'note.txt', size: 2048, attachmentId: 'a1' });
    expect(card().textContent).toContain('note.txt');
    expect(card().textContent).toContain('2.0 KB');
  });

  it('во время загрузки показывает, что файл едет, и не даёт скачивать', () => {
    render({ url: '', name: 'big.zip', size: 0, placeholder: true });
    expect(card().textContent).toContain('Uploading');
    expect(card().querySelector('a')).toBeNull();
  });

  it('встраивание PDF предлагается только для PDF и только в правке', () => {
    render({ url: '/files/a1/doc.pdf', name: 'doc.pdf', size: 10, attachmentId: 'a1' });
    expect(card().querySelector('button[aria-label="Embed as PDF"]')).not.toBeNull();

    if (component) void unmount(component);
    host?.remove();
    render({ url: '/files/a1/doc.pdf', name: 'doc.pdf', size: 10 }, { editable: false });
    expect(card().querySelector('button[aria-label="Embed as PDF"]')).toBeNull();

    if (component) void unmount(component);
    host?.remove();
    render({ url: '/files/a1/note.txt', name: 'note.txt', size: 10 });
    expect(card().querySelector('button[aria-label="Embed as PDF"]')).toBeNull();
  });

  it('встраивание заменяет узел, а не дописывает второй', () => {
    const world = render({
      url: '/files/a1/doc.pdf',
      name: 'doc.pdf',
      size: 10,
      attachmentId: 'a1'
    });
    card().querySelector<HTMLButtonElement>('button[aria-label="Embed as PDF"]')?.click();
    flushSync();
    expect(world.inserted).toEqual([
      {
        range: { from: 4, to: 5 },
        content: {
          type: 'pdf',
          attrs: { src: '/files/a1/doc.pdf', name: 'doc.pdf', attachmentId: 'a1', size: 10 }
        }
      }
    ]);
  });

  it('пропавший файл называет причину, а не открывает отказ сервера', async () => {
    const opened = vi.spyOn(window, 'open').mockReturnValue(null);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ status: 404 } as Response);
    render({ url: '/files/a1/note.txt', name: 'note.txt', size: 10 });
    card()
      .querySelector('a')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => {
      flushSync();
      expect(host?.querySelector('[role="alert"]')).not.toBeNull();
    });
    expect(opened).not.toHaveBeenCalled();
  });

  it('живой файл открывается новой вкладкой', async () => {
    const opened = vi.spyOn(window, 'open').mockReturnValue(null);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ status: 200 } as Response);
    render({ url: '/files/a1/note.txt', name: 'note.txt', size: 10 });
    card()
      .querySelector('a')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => expect(opened).toHaveBeenCalled());
    flushSync();
    expect(host?.querySelector('[role="alert"]')).toBeNull();
  });

  it('отметка «не найдётся поиском» приходит с сервера', async () => {
    vi.mocked(attachments.attachmentInfo).mockResolvedValue({
      id: 'a1',
      fileName: 'scan.pdf',
      fileSize: 10,
      mimeType: 'application/pdf',
      pageId: 'p1',
      updatedAt: null,
      indexStatus: 'unsupported'
    });
    render({ url: '/files/a1/scan.pdf', name: 'scan.pdf', size: 10, attachmentId: 'a1' });
    await vi.waitFor(() => {
      flushSync();
      expect(card().textContent).toContain('not searchable');
    });
  });

  it('без отметки от сервера ничего не обещает', async () => {
    render({ url: '/files/a1/note.txt', name: 'note.txt', size: 10, attachmentId: 'a1' });
    await vi.waitFor(() => expect(attachments.attachmentInfo).toHaveBeenCalled());
    flushSync();
    expect(card().textContent).not.toContain('not searchable');
  });
});
