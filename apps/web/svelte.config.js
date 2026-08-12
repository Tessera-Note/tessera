import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/**
 * Сборка узлом, а не статикой.
 *
 * Продукт разворачивается своим docker compose за обратным прокси, и часть
 * маршрутов требует серверной отдачи: настройки экземпляра читаются из
 * окружения на старте, а не зашиваются в бандл.
 *
 * @type {import('@sveltejs/kit').Config}
 */
export default {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
    alias: {
      $lib: 'src/lib'
    }
  }
};
