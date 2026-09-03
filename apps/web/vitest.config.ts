import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig, type Plugin } from 'vitest/config';

/**
 * Проверки отдельным файлом настроек.
 *
 * Vite и Vitest в восьмой версии перестали делить один тип настроек, и раздел
 * `test` в общем файле не проходит проверку типов. Разделение здесь дешевле
 * подавления ошибки: сборка и проверки настраиваются по-разному и дальше.
 */

// `$lib` разрешает SvelteKit, а проверки идут мимо него. Без этого проверить
// можно только то, что ничего из `$lib` не импортирует, а это исключает
// разбор отказов — он начинается с `ApiError`.
const alias = { $lib: fileURLToPath(new URL('./src/lib', import.meta.url)) };

/**
 * Подмены модулей SvelteKit.
 *
 * `$app/*` и `$env/*` подставляет сам SvelteKit при сборке, а проверки идут
 * мимо него. Без подмены нельзя проверить ни один компонент, чей граф импортов
 * доходит до слоя обращений к серверу, — а это почти каждый.
 */
const domAlias = {
  ...alias,
  '$app/environment': fileURLToPath(
    new URL('./src/test-stubs/app-environment.ts', import.meta.url)
  ),
  '$env/static/public': fileURLToPath(
    new URL('./src/test-stubs/env-static-public.ts', import.meta.url)
  ),
  '$app/navigation': fileURLToPath(new URL('./src/test-stubs/app-navigation.ts', import.meta.url))
};

/**
 * Пустые значки на время проверок.
 *
 * В наборе Tabler 12370 значков одним перечнем, и сборщик разбирает их все на
 * каждый прогон: тридцать секунд на проверку, которая смотрит на разметку, а не
 * на картинки. Здесь набор подменяется модулем, где каждое имя — пустой
 * компонент. Имена берутся из самого пакета, поэтому опечатка в имени значка
 * так же остаётся отказом сборки.
 *
 * На сборку это не влияет: подмена живёт только в настройках проверок.
 */
function blankIcons(): Plugin {
  const NAME = '@tabler/icons-svelte';
  const VIRTUAL = '\0tabler-blank-icons';

  return {
    name: 'tessera:blank-icons',
    enforce: 'pre',
    resolveId(id) {
      return id === NAME ? VIRTUAL : null;
    },
    load(id) {
      if (id !== VIRTUAL) return null;

      // Через сам перечень значков: `package.json` пакет наружу не отдаёт,
      // а этот путь объявлен в его `exports`.
      const require = createRequire(import.meta.url);
      const entry = require.resolve(NAME);
      const source = readFileSync(join(dirname(entry), 'icons/index.js'), 'utf8');
      const names = [...new Set(source.match(/\bIcon[A-Za-z0-9]+/g) ?? [])];

      return [
        '// Пустой компонент: значок в проверках разметки ничего не решает.',
        'function blank() {}',
        `export { ${names.map((one) => `blank as ${one}`).join(', ')} };`
      ].join('\n');
    }
  };
}

export default defineConfig({
  resolve: { alias },
  test: {
    /**
     * Проверки двух видов, и разделены они не для порядка.
     *
     * Разбор данных проверяется в среде без окна: там нет ни DOM, ни браузерных
     * условий разрешения модулей, и такая проверка ловит случайную зависимость
     * от браузера — ту самую, из-за которой модуль перестаёт собираться на
     * сервере.
     *
     * Разметка проверяется в `jsdom`, с условием разрешения `browser` и с
     * подключённым сборщиком Svelte. Без условия `@sveltejs/vite-plugin-svelte`
     * собирает компонент для отрисовки на сервере: такой компонент в DOM не
     * вставляется и на нажатия не отвечает.
     *
     * Различаются по имени файла: `*.svelte.test.ts` — разметка компонента,
     * `*.dom.test.ts` — разбор, которому нужно окно, но не нужен компонент
     * (правка узлов разметки, буфер обмена), остальные — чистый разбор. Своего
     * браузера в проверках нет и не будет: это была бы новая зависимость,
     * которая ещё и качает бинарник из интернета.
     */
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.svelte.test.ts', 'src/**/*.dom.test.ts']
        }
      },
      {
        plugins: [blankIcons(), svelte()],
        resolve: { alias: domAlias, conditions: ['browser'] },
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: ['src/**/*.svelte.test.ts', 'src/**/*.dom.test.ts'],
          setupFiles: ['./src/dom-setup.ts']
        }
      }
    ]
  }
});
