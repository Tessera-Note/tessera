import { get, post } from '$lib/api/client';

export type WorkspaceSettings = {
  id: string;
  name: string | null;
  description: string | null;
  hostname: string | null;
  trashRetentionDays: number | null;
  enforceMfa: boolean;
  enforceSso: boolean;
  disablePublicSharing: boolean;
  restrictApiToAdmins: boolean;
  allowMemberTemplates: boolean;
  allowPersonalSpaces: boolean;
  /** Помощник. Включён, пока его не выключили: в v1 выключателя нет вовсе. */
  aiChatEnabled: boolean;
  /** Умный поиск по смыслу. Включён по той же причине, что и помощник. */
  aiSearchEnabled: boolean;
  aiGenerativeEnabled: boolean;
  /** Домены почты, с которых принимается заведение записи. Пусто — любые. */
  emailDomains: string[];
  /** Включён ли канал MCP. Тот же признак читает маршрут `/api/mcp`. */
  mcpEnabled: boolean;
  /** С чего открывает страницу тот, кто своего выбора не делал. */
  defaultPageEditMode: string;
  /** Включена ли синхронизация учётных записей по SCIM. */
  isScimEnabled: boolean;
};

/** Правится по одному полю: экран шлёт изменённое, остальное сервер не трогает. */
export type WorkspacePatch = Partial<
  Omit<WorkspaceSettings, 'id' | 'hostname'> & { trashRetentionDays: number }
>;

export function workspaceSettings(fetcher?: typeof fetch, headers?: Record<string, string>) {
  return get<WorkspaceSettings>('/api/workspace/settings', { fetcher, headers });
}

/** Выпуск: своя версия, доступная и адрес записей о выпусках. */
export type Version = {
  currentVersion: string;
  latestVersion: string | null;
  releaseUrl: string;
  docsUrl: string;
  apiDocsUrl: string;
};

/**
 * Сведения о выпуске.
 *
 * Отдаёт их соседний сервис, и развёртывание без него — обычный случай.
 * Вызывающий обязан пережить отказ: номер версии в панели важен, но не
 * настолько, чтобы из-за недоступного соседа не открылся раздел настроек.
 */
export function version(fetcher?: typeof fetch, headers?: Record<string, string>) {
  return post<Version>('/api/version', {}, { fetcher, headers });
}

export function updateWorkspace(values: WorkspacePatch, fetcher?: typeof fetch) {
  return post<WorkspaceSettings>('/api/workspace/update', values, { fetcher });
}
