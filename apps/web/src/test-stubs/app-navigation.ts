/**
 * `$app/navigation` для проверок разметки.
 *
 * Настоящий модуль подставляет SvelteKit при сборке. Переходы здесь ничего не
 * делают: проверяется, что компонент их зовёт и с чем, а не то, что умеет
 * маршрутизатор. Вызовы записываются, чтобы проверка могла их прочитать.
 */

export const calls: { goto: string[]; invalidateAll: number } = { goto: [], invalidateAll: 0 };

export async function goto(target: string): Promise<void> {
  calls.goto.push(target);
}

export async function invalidateAll(): Promise<void> {
  calls.invalidateAll += 1;
}

export async function invalidate(): Promise<void> {}

export function preloadData(): Promise<void> {
  return Promise.resolve();
}

export function preloadCode(): Promise<void> {
  return Promise.resolve();
}
