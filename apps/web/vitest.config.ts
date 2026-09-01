import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Проверки отдельным файлом настроек.
 *
 * Vite и Vitest в восьмой версии перестали делить один тип настроек, и раздел
 * `test` в общем файле не проходит проверку типов. Разделение здесь дешевле
 * подавления ошибки: сборка и проверки настраиваются по-разному и дальше.
 */
export default defineConfig({
  // `$lib` разрешает SvelteKit, а проверки идут мимо него. Без этого проверить
  // можно только то, что ничего из `$lib` не импортирует, а это исключает
  // разбор отказов — он начинается с `ApiError`.
  resolve: {
    alias: {
      $lib: fileURLToPath(new URL('./src/lib', import.meta.url))
    }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
});
