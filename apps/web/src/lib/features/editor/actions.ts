/**
 * Что вставка блока делает за пределами документа.
 *
 * Перечень блоков (`blocks.ts`) сам к серверу не ходит: он должен читаться
 * проверкой, а обращение к серверу тянет за собой окружение SvelteKit. Всё,
 * что выходит наружу — загрузка файла и заведение базы, — собрано здесь и
 * передаётся вставке доводом.
 *
 * Порядок в обоих случаях обратный тому, что в v1: там сначала вставляется
 * пустой узел-заглушка, а после ответа сервера он подменяется настоящим. Здесь
 * узел заводится уже готовым. Причина в общем документе: заглушка это правка,
 * она уходит всем соединённым, и при отказе сервера у соседа остаётся рамка,
 * которая никогда не наполнится.
 */

import type { Editor } from '@tiptap/core';
import { createBase } from '$lib/features/base/services/bases';
import { ACCEPT, pickFile, uploadAndInsert, type MediaKind } from './upload';

export type BlockActions = {
  upload: (kind: MediaKind) => void;
  createBase: (template?: 'kanban') => void;
};

export function blockActions(
  editor: Editor,
  pageId: string,
  fail: (error: unknown) => void
): BlockActions {
  return {
    upload(kind) {
      void (async () => {
        const file = await pickFile(ACCEPT[kind]);
        if (!file) return;
        try {
          await uploadAndInsert(editor, pageId, kind, file);
        } catch (error) {
          fail(error);
        }
      })();
    },

    createBase(template) {
      void (async () => {
        try {
          const { id } = await createBase({ parentPageId: pageId, template });
          editor.chain().focus().insertBaseEmbed({ pageId: id }).run();
        } catch (error) {
          fail(error);
        }
      })();
    }
  };
}
