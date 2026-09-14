/**
 * Кто ещё открыл эту страницу.
 *
 * Сведения приходят из awareness канала совместного редактирования: каждая
 * подключённая вкладка объявляет там себя, и тот же набор рисует чужой курсор
 * в тексте. Отдельного запроса к серверу не заводится — он показал бы
 * присутствие с отставанием и разошёлся бы с курсорами.
 *
 * Разбор вынесен из компонента: он сводится к правилам («одна вкладка это не
 * один человек», «себя в перечне быть не должно»), а правила проверяются без
 * поднятия редактора.
 */

/** Человек на странице. Вкладок у него бывает несколько, запись одна. */
export type Present = {
  /** Идентификатор учётной записи. По нему и сводятся вкладки. */
  id: string;
  name: string;
  /** Цвет курсора. Тот же, что в тексте: перечень и текст обязаны сходиться. */
  color: string;
  avatarUrl: string | null;
  /** Сколько вкладок открыто. Единица — обычный случай. */
  tabs: number;
};

/** Состояние одной вкладки так, как его отдаёт канал. */
export type AwarenessState = {
  clientId: number;
  [key: string]: unknown;
};

/**
 * Свести объявленные состояния в перечень людей.
 *
 * Своя вкладка отбрасывается по `clientId`, а не по идентификатору человека:
 * тот же человек, открывший страницу во второй вкладке, — настоящее
 * присутствие, и скрывать его значит показывать пустой перечень там, где
 * рядом правят.
 *
 * Состояние без имени пропускается. Оно бывает в короткий промежуток между
 * подключением вкладки и объявлением ею себя, и запись «?» в перечне жила бы
 * ровно этот промежуток, мигая на каждом подключении.
 */
export function presentPeople(states: AwarenessState[], selfClientId: number | null): Present[] {
  const found = new Map<string, Present>();

  for (const state of states) {
    if (selfClientId !== null && state.clientId === selfClientId) continue;
    const user = state.user as Partial<Present> | undefined;
    if (!user) continue;

    const name = typeof user.name === 'string' ? user.name.trim() : '';
    if (!name) continue;

    // Запасной ключ — имя: без идентификатора вкладки одного человека свести
    // не по чему, но и слить двух разных нельзя.
    const key = typeof user.id === 'string' && user.id ? user.id : `name:${name}`;
    const known = found.get(key);
    if (known) {
      known.tabs += 1;
      continue;
    }
    found.set(key, {
      id: key,
      name,
      color: typeof user.color === 'string' ? user.color : 'currentColor',
      avatarUrl: typeof user.avatarUrl === 'string' ? user.avatarUrl : null,
      tabs: 1
    });
  }

  // Порядок по имени: awareness отдаёт состояния в порядке подключения, и
  // перечень переставлялся бы при каждом чужом обновлении курсора.
  return [...found.values()].sort((one, two) => one.name.localeCompare(two.name));
}
