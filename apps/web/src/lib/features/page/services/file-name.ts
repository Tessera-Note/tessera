/**
 * Имя файла из заголовка ответа.
 *
 * Отдельным файлом и без единого импорта, как разбор отказа и разбор кадров:
 * `transfer.ts` тянет адрес API, а с ним модули SvelteKit, и проверить разбор
 * заголовка, не поднимая половину приложения, было бы нельзя.
 */

/**
 * Имя файла из `Content-Disposition`.
 *
 * Сервер пишет его дважды: обычным полем и в кодировке UTF-8. Читается второе,
 * когда оно есть: названия страниц бывают на любом языке, а обычное поле
 * допускает только латиницу, и кириллическое имя доезжает в нём искажённым.
 */
export function fileNameOf(disposition: string | null, fallback: string): string {
  if (!disposition) return fallback;

  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (utf8) {
    try {
      return decodeURIComponent(utf8[1].trim());
    } catch {
      // Имя закодировано не так, как обещано заголовком: берётся запасное.
      return fallback;
    }
  }

  const plain = /filename="([^"]*)"/i.exec(disposition);
  if (!plain?.[1]) return fallback;
  try {
    return decodeURIComponent(plain[1]);
  } catch {
    return plain[1];
  }
}
