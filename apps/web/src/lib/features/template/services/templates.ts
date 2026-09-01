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

export function listTemplates(fetcher?: typeof fetch, headers?: Record<string, string>) {
  return post<Template[]>('/api/templates/', {}, { fetcher, headers });
}

export function templateInfo(
  templateId: string,
  fetcher?: typeof fetch,
  headers?: Record<string, string>
) {
  return post<TemplateBody>('/api/templates/info', { templateId }, { fetcher, headers });
}

export function updateTemplate(
  values: { templateId: string; title?: string; description?: string },
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
