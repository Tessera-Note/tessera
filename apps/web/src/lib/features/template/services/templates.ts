import { post } from '$lib/api/client';

export type Template = {
  id: string;
  title: string;
  description: string | null;
  icon: string | null;
  spaceId: string | null;
  creatorId: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Шаблон вместе с содержимым. Список его не несёт: он открывается ради выбора. */
export type TemplateBody = Template & { content: unknown };

/** Созданная по шаблону страница. */
export type MadePage = {
  id: string;
  slugId: string;
  title: string | null;
  icon: string | null;
  spaceId: string;
};

/** Страница перечня и место, откуда продолжать. */
export type TemplatePage = {
  items: Template[];
  meta: { nextCursor: string | null };
};

/**
 * Шаблоны, доступные человеку.
 *
 * Отбор по области — доводом, а не после выдачи: отобранная на клиенте
 * страница выходила бы пустой при том, что подходящие шаблоны есть дальше.
 */
export function listTemplates(
  values: { spaceId?: string; cursor?: string; limit?: number } = {},
  fetcher?: typeof fetch,
  headers?: Record<string, string>
) {
  return post<TemplatePage>('/api/templates/', values, { fetcher, headers });
}

export function templateInfo(
  templateId: string,
  fetcher?: typeof fetch,
  headers?: Record<string, string>
) {
  return post<TemplateBody>('/api/templates/info', { templateId }, { fetcher, headers });
}

/**
 * Завести шаблон.
 *
 * Содержимое берётся из страницы: шаблон и заводят затем, чтобы повторить
 * удачную страницу. Пустой `spaceId` означает шаблон рабочего пространства.
 */
export function createTemplate(
  values: {
    title: string;
    description?: string;
    icon?: string;
    content?: unknown;
    spaceId?: string;
  },
  fetcher?: typeof fetch
) {
  return post<Template>('/api/templates/create', values, { fetcher });
}

/**
 * Изменить шаблон.
 *
 * `move` отдельным признаком, а не пустым `moveToSpaceId`: пустое значение
 * означает «шаблон рабочего пространства», а не «область не меняем», и без
 * признака перенести шаблон в рабочее пространство было бы нечем.
 */
export function updateTemplate(
  values: {
    templateId: string;
    title?: string;
    description?: string;
    icon?: string;
    content?: unknown;
    moveToSpaceId?: string;
    move?: boolean;
  },
  fetcher?: typeof fetch
) {
  return post<Template>('/api/templates/update', values, { fetcher });
}

export function deleteTemplate(templateId: string, fetcher?: typeof fetch) {
  return post<{ success: boolean }>('/api/templates/delete', { templateId }, { fetcher });
}

/**
 * Завести страницу по шаблону.
 *
 * Область обязательна: шаблон рабочего пространства сам по себе не знает, где
 * должна появиться страница.
 */
export function useTemplate(
  values: { templateId: string; spaceId: string; parentPageId?: string },
  fetcher?: typeof fetch
) {
  return post<MadePage>('/api/templates/use', values, { fetcher });
}
