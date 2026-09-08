/**
 * Тема оформления.
 *
 * Значение живёт на корне документа, а не в разметке компонентов: его
 * подставляет скрипт в оболочке до первой отрисовки, и второй источник дал бы
 * вспышку светлого экрана при загрузке.
 *
 * Выбор и показанное — разные вещи. Выбор бывает трёх видов, как в v1: светлая,
 * тёмная и «как в системе»; показанная тема всегда одна из двух. Без третьего
 * вида человек, у которого система переключается по времени суток, вынужден
 * переключать вики руками следом.
 */

export type Theme = 'light' | 'dark';
export type ThemeChoice = Theme | 'auto';

const STORAGE_KEY = 'tessera.theme';

/** Тёмная ли тема в системе. Вне браузера — нет: там системы и нет. */
function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

class ThemeStore {
  /** Что показано сейчас. По нему выбирают цвета метки и подсветку кода. */
  current = $state<Theme>('light');

  /** Что выбрал человек. `auto` означает «как в системе». */
  choice = $state<ThemeChoice>('light');

  /** Прочитать выбранное. Вызывается на клиенте: в разметке сервера окна нет. */
  hydrate() {
    if (typeof document === 'undefined') return;

    let saved: string | null = null;
    try {
      saved = localStorage.getItem(STORAGE_KEY);
    } catch {
      // Хранилище недоступно в закрытом окне. Останется то, что на корне.
    }

    this.choice = saved === 'dark' || saved === 'auto' ? saved : 'light';
    this.apply();
    this.watchSystem();
  }

  /**
   * Запомнить выбор и показать его.
   *
   * `auto` тоже записывается: иначе после перезагрузки он превращался бы в
   * светлую тему, и выбор «как в системе» жил бы одну сессию.
   */
  set(value: ThemeChoice) {
    this.choice = value;
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch {
      // Хранилище недоступно. Тема останется до перезагрузки.
    }
    this.apply();
  }

  /** Переключатель в шапке: он знает два состояния, а не три. */
  toggle() {
    this.set(this.current === 'dark' ? 'light' : 'dark');
  }

  private apply() {
    const shown: Theme =
      this.choice === 'auto' ? (systemPrefersDark() ? 'dark' : 'light') : this.choice;
    this.current = shown;
    if (typeof document === 'undefined') return;
    document.documentElement.setAttribute('data-theme', shown);
  }

  /**
   * Следить за системой.
   *
   * Только при выборе «как в системе»: подписка ставится один раз и сама
   * проверяет выбор, потому что снимать и ставить её на каждую смену выбора —
   * это хранить ещё и отписку.
   */
  private watchSystem() {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const react = () => {
      if (this.choice === 'auto') this.apply();
    };
    if (typeof media.addEventListener === 'function') media.addEventListener('change', react);
  }
}

export const theme = new ThemeStore();
