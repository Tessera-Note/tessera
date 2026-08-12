/**
 * Тема оформления.
 *
 * Значение живёт на корне документа, а не в разметке компонентов: его
 * подставляет скрипт в оболочке до первой отрисовки, и второй источник дал бы
 * вспышку светлого экрана при загрузке.
 */

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'tessera.theme';

class ThemeStore {
  current = $state<Theme>('light');

  /** Прочитать выбранное. Вызывается на клиенте: в разметке сервера окна нет. */
  hydrate() {
    if (typeof document === 'undefined') return;
    const attribute = document.documentElement.getAttribute('data-theme');
    this.current = attribute === 'dark' ? 'dark' : 'light';
  }

  set(value: Theme) {
    this.current = value;
    if (typeof document === 'undefined') return;
    document.documentElement.setAttribute('data-theme', value);
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch {
      // Хранилище недоступно в закрытом окне. Тема останется до перезагрузки.
    }
  }

  toggle() {
    this.set(this.current === 'dark' ? 'light' : 'dark');
  }
}

export const theme = new ThemeStore();
