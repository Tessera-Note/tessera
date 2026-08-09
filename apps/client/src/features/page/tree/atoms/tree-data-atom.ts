import { atom } from "jotai";
import { SpaceTreeNode } from "@/features/page/tree/types";
import { appendNodeChildren } from "../utils";

export const treeDataAtom = atom<SpaceTreeNode[]>([]);

/**
 * Счетчик запросов на перезаполнение дерева.
 *
 * Сервер событием `refetchRootTreeNodeEvent` просит клиента обновить корень
 * пространства, и обработчик вычищает его узлы из атома. Заполнение обратно
 * делает эффект в `SpaceTree`, который сторожил данные запроса **по ссылке**.
 * React Query применяет структурное разделение: если перезапрос вернул то же
 * самое, ссылка не меняется, эффект не срабатывает, и дерево остается пустым.
 * Так падала вся навигация от переименования дочерней страницы, корневой
 * список которой не меняется.
 *
 * Счетчик делает восстановление **явным действием**: он меняется всегда,
 * независимо от того, изменился ли ответ сервера. Отключать структурное
 * разделение ради этого нельзя, оно нужно всем остальным читателям тех же
 * данных.
 */
export const treeRefreshTokenAtom = atom<number>(0);

// Atom
export const appendNodeChildrenAtom = atom(
  null,
  (
    get,
    set,
    { parentId, children }: { parentId: string; children: SpaceTreeNode[] },
  ) => {
    const currentTree = get(treeDataAtom);
    const updatedTree = appendNodeChildren(currentTree, parentId, children);
    set(treeDataAtom, updatedTree);
  },
);
