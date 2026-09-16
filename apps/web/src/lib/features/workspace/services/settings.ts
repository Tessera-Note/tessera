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

/**
 * Срок корзины, пока своего не задано. Столько ждёт очистка
 * (`DEFAULT_TRASH_RETENTION_DAYS` в `apps/api/tessera_api/services/maintenance.py`),
 * совпадение стережёт проверка.
 */
export const DEFAULT_TRASH_RETENTION_DAYS = 30;

/**
 * Срок, который показывается в подсказке к полю.
 *
 * Пустое поле — это срок по умолчанию, а не ноль: без этого подсказка обещала
 * удалить страницы «через 0 дней», хотя очистка ждёт тридцать.
 */
export function trashRetentionShown(value: string): number {
  const days = Number(value);
  return value.trim() !== '' && days > 0 ? days : DEFAULT_TRASH_RETENTION_DAYS;
}

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

/**
 * Перенести внешние картинки уже написанных страниц в своё хранилище.
 *
 * Право распорядителя: проход переписывает тела чужих страниц. Ответ означает
 * «поставлено в очередь», а не «сделано»: проход обходит страницы
 * пространства и скачивает каждую картинку, итог уходит в журнал аудита.
 */
export function rehostImages(fetcher?: typeof fetch) {
  return post<{ scheduled: boolean }>('/api/workspace/rehost-images', {}, { fetcher });
}
