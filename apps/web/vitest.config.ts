import { defineConfig } from 'vitest/config';

/**
 * Проверки отдельным файлом настроек.
 *
 * Vite и Vitest в восьмой версии перестали делить один тип настроек, и раздел
 * `test` в общем файле не проходит проверку типов. Разделение здесь дешевле
 * подавления ошибки: сборка и проверки настраиваются по-разному и дальше.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
});
