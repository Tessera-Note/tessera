import { atom } from "jotai";
import { Editor } from "@tiptap/core";
import { PageEditMode } from "@/features/user/types/user.types.ts";

export const pageEditorAtom = atom<Editor | null>(null);

export const titleEditorAtom = atom<Editor | null>(null);

export const readOnlyEditorAtom = atom<Editor | null>(null);

export const yjsConnectionStatusAtom = atom<string>("");

export const yjsSyncedAtom = atom<boolean>(false);

export const showAiMenuAtom = atom(false);

export const showLinkMenuAtom = atom(false);

// Current page's edit mode — initialized from the user's saved preference on
// first load, can be toggled locally without persisting to the server.
export const currentPageEditModeAtom = atom<PageEditMode>(PageEditMode.Edit);

/**
 * Права на открытой странице, отозванные или пониженные уже после загрузки.
 *
 * Сервер перепроверяет доступ у открытых соединений периодически и сообщает
 * об изменении служебным сообщением канала коллаборации. Состояние общее для
 * заголовка и тела страницы: это два разных редактора, и без общего состояния
 * заголовок остался бы редактируемым после отзыва прав на содержимое.
 *
 * Сбрасывается при переходе на другую страницу.
 */
export type CollabAccessState = {
  /** Доступ к странице отозван целиком, соединение закрыто сервером. */
  revoked: boolean;
  /** Доступ остался, но право правки снято. */
  readOnly: boolean;
};

export const collabAccessDefault: CollabAccessState = {
  revoked: false,
  readOnly: false,
};

export const collabAccessAtom = atom<CollabAccessState>(collabAccessDefault);
