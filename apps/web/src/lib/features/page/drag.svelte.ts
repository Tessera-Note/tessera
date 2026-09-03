/**
 * Что сейчас перетаскивают в дереве страниц.
 *
 * Состояние одно на всё дерево: перетаскиваемая страница видна и той ветви,
 * откуда её взяли, и той, куда несут, а браузерный `dataTransfer` отдаёт
 * содержимое только в момент броска — подсветить место заранее по нему нельзя.
 */

import type { DropZone } from './drop-zone';

class DragState {
  /** Что тащат. Пусто, когда ничего не тащат. */
  pageId = $state<string | null>(null);
  /** Над какой строкой держат и в какую её часть. */
  overId = $state<string | null>(null);
  zone = $state<DropZone>('inside');

  start(pageId: string) {
    this.pageId = pageId;
  }

  over(pageId: string, zone: DropZone) {
    this.overId = pageId;
    this.zone = zone;
  }

  end() {
    this.pageId = null;
    this.overId = null;
  }
}

export const drag = new DragState();
