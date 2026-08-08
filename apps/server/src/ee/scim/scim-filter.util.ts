/**
 * Разбор фильтров списков SCIM.
 *
 * Поддерживается ровно то, что провайдеры используют на практике: точное
 * сравнение по `userName`, `externalId`, адресу почты и `displayName`.
 * Остальное отвергается явно, а не игнорируется молча: молча отброшенный
 * фильтр вернул бы весь каталог там, где провайдер спрашивал одну запись, и
 * тот счел бы всех остальных подлежащими удалению.
 */
export type ScimUserFilter = {
  userName?: string;
  email?: string;
  externalId?: string;
};

/** Разбор фильтра списка групп. */
export type ScimGroupFilter = {
  displayName?: string;
  externalId?: string;
};

const SUPPORTED_USER = [
  'username',
  'externalid',
  'emails.value',
  'emails',
] as const;

const SUPPORTED_GROUP = ['displayname', 'externalid'] as const;

export class UnsupportedScimFilterError extends Error {}

/**
 * Разбор одного сравнения на равенство: `attr eq "value"`.
 *
 * Общая часть для обоих ресурсов. Грамматика фильтров SCIM много шире, но
 * поддерживается ровно то, что провайдеры шлют на практике, а остальное
 * отвергается явно.
 */
function parseEquality(
  filter: string,
): { attribute: string; raw: string; value: string } | null {
  const match = filter.trim().match(/^([A-Za-z][\w.]*)\s+eq\s+"([^"]*)"$/i);
  if (!match) return null;

  return { attribute: match[1].toLowerCase(), raw: match[1], value: match[2] };
}

function requireEquality(filter: string) {
  const parsed = parseEquality(filter);
  if (!parsed) {
    throw new UnsupportedScimFilterError(
      `Unsupported filter: ${filter}. Only 'attribute eq "value"' is supported`,
    );
  }
  return parsed;
}

export function parseScimUserFilter(filter?: string): ScimUserFilter {
  if (!filter || !filter.trim()) return {};

  const { attribute, raw, value } = requireEquality(filter);

  if (!SUPPORTED_USER.includes(attribute as any)) {
    throw new UnsupportedScimFilterError(
      `Filtering by '${raw}' is not supported`,
    );
  }

  if (attribute === 'externalid') return { externalId: value };
  if (attribute === 'username') return { userName: value };
  return { email: value };
}

export function parseScimGroupFilter(filter?: string): ScimGroupFilter {
  if (!filter || !filter.trim()) return {};

  const { attribute, raw, value } = requireEquality(filter);

  if (!SUPPORTED_GROUP.includes(attribute as any)) {
    throw new UnsupportedScimFilterError(
      `Filtering by '${raw}' is not supported`,
    );
  }

  if (attribute === 'externalid') return { externalId: value };
  return { displayName: value };
}
