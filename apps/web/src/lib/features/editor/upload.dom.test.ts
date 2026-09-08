/**
 * Картинка по вставленному адресу.
 *
 * Чужая ссылка живёт своей жизнью: сегодня открывается, завтра адрес меняется,
 * а на закрытом контуре её не видно вовсе. Поэтому файл переносится в своё
 * хранилище, и в документе остаётся свой адрес.
 *
 * Проверяется разделение исходов: не картинка — это обычная вставка ссылки, а
 * мёртвый адрес — отказ, который обязан дойти до человека.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '$lib/api/client';

const fetchImageUrl = vi.fn();
vi.mock('$lib/features/page/services/attachments', () => ({
  fetchImageUrl: (...args: unknown[]) => fetchImageUrl(...args),
  uploadPageFile: () => Promise.resolve({})
}));

const { insertImageFromUrl } = await import('./upload');

/** Редактор в объёме, который нужен вставке узла. */
function editor() {
  const setImage = vi.fn(() => ({ run: () => {} }));
  const chain = { focus: () => ({ setImage }) };
  return { editor: { chain: () => chain } as never, setImage };
}

beforeEach(() => {
  fetchImageUrl.mockReset();
});

describe('insertImageFromUrl', () => {
  it('переносит картинку и вставляет свой адрес', async () => {
    fetchImageUrl.mockResolvedValue({
      id: 'a1',
      fileName: 'постер.png',
      fileSize: 1024,
      mimeType: 'image/png',
      pageId: 'p1',
      updatedAt: null,
      url: '/api/files/a1/постер.png'
    });
    const { editor: made, setImage } = editor();

    const outcome = await insertImageFromUrl(made, 'p1', 'https://example.com/постер.png');

    expect(outcome).toBe('image');
    expect(fetchImageUrl).toHaveBeenCalledWith('p1', 'https://example.com/постер.png');
    // Свой адрес, а не чужой: ради этого перенос и делается.
    expect(setImage).toHaveBeenCalledWith(
      expect.objectContaining({ src: '/api/files/a1/%D0%BF%D0%BE%D1%81%D1%82%D0%B5%D1%80.png' })
    );
  });

  it('не картинка — это не отказ, а обычная ссылка', async () => {
    fetchImageUrl.mockRejectedValue(
      new ApiError(400, 'error.media.not_an_image', 'not an image', {})
    );
    const { editor: made, setImage } = editor();

    await expect(insertImageFromUrl(made, 'p1', 'https://example.com/статья')).resolves.toBe(
      'not-an-image'
    );
    expect(setImage).not.toHaveBeenCalled();
  });

  it('мёртвый адрес доходит отказом', async () => {
    // Ровно тот случай, ради которого проверка адреса и заведена: ссылка
    // выглядит целой, а не открывается.
    fetchImageUrl.mockRejectedValue(
      new ApiError(400, 'error.media.not_reachable', 'answered 404', {})
    );
    const { editor: made } = editor();

    await expect(insertImageFromUrl(made, 'p1', 'https://example.com/нет.png')).rejects.toThrow();
  });
});
