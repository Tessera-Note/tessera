/**
 * `$app/environment` для проверок разметки.
 *
 * Настоящий модуль подставляет SvelteKit при сборке, а проверки идут мимо него.
 * Без подмены нельзя проверить ни один компонент, чей граф импортов доходит до
 * слоя обращений к серверу, — а это почти каждый.
 *
 * `browser` здесь истина: проверки разметки идут в `jsdom`, то есть в окне.
 */
export const browser = true;
export const building = false;
export const dev = true;
export const version = 'test';
