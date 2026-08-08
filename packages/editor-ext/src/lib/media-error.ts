/**
 * Обработка недоступного вложения в узлах, которые рисуются обычным DOM.
 *
 * Узлы `image`, `video`, `drawio` и `excalidraw` идут через `ResizableNodeView`,
 * который до загрузки ставит контейнеру `pointer-events: none` и класс
 * пульсации. Снималось это **только** в обработчике успешной загрузки, поэтому
 * при 404 или 403 узел навсегда оставался пульсирующей заглушкой: его нельзя
 * было ни выделить мышью, ни потянуть, ни открыть в меню. Состояние чисто
 * runtime, в содержимом ничего не хранится, поэтому оно снимается само, как
 * только узел отрисовывается этим кодом.
 *
 * Тексты приходят из приложения: пакет расширений не знает про i18next, а
 * пользовательские строки обязаны идти через него. До установки берутся
 * английские значения по умолчанию, чтобы пакет оставался самостоятельным.
 */
export type MediaErrorLabels = {
  /** Файла нет: 404. */
  missing: string;
  /** Файл есть, доступа нет: 403. */
  forbidden: string;
  /** Все прочее, включая обрыв сети. */
  failed: string;
};

let labels: MediaErrorLabels = {
  missing: 'This file no longer exists. It may have been deleted.',
  forbidden: "You don't have access to this file.",
  failed: 'Failed to load this file.',
};

export function setMediaErrorLabels(next: MediaErrorLabels): void {
  labels = next;
}

export function getMediaErrorLabels(): MediaErrorLabels {
  return labels;
}

/**
 * Код ответа для адреса, который не смог загрузить `img` или `video`.
 *
 * Тег о причине отказа ничего не сообщает, поэтому статус выясняется
 * отдельным запросом. Он делается **только** после отказа, поэтому на
 * обычном пути стоимости не добавляет.
 */
export async function resolveMediaErrorStatus(
  src: string,
): Promise<number | undefined> {
  try {
    const response = await fetch(src, {
      method: 'GET',
      credentials: 'include',
      // Ответ нужен только ради статуса, тело не читается.
      cache: 'no-store',
    });
    return response.status;
  } catch {
    return undefined;
  }
}

export function mediaErrorMessage(status: number | undefined): string {
  if (status === 404) return labels.missing;
  if (status === 403) return labels.forbidden;
  return labels.failed;
}

/**
 * Снять блокировку и показать причину.
 *
 * Порядок важен: блокировка снимается сразу и не ждет запроса за статусом,
 * иначе узел оставался бы неподвижным еще на время round-trip.
 */
export function handleMediaError(
  dom: HTMLElement,
  el: HTMLElement,
  src: string | null | undefined,
): void {
  dom.style.pointerEvents = '';
  dom.style.visibility = '';
  el.classList.remove('media-pulse');
  el.classList.add('media-failed');
  dom.dataset.mediaError = 'unknown';

  const notice = document.createElement('div');
  notice.className = 'media-error-notice';
  notice.textContent = labels.failed;
  dom.appendChild(notice);

  if (!src) return;

  void resolveMediaErrorStatus(src).then((status) => {
    if (status === undefined) return;
    dom.dataset.mediaError = String(status);
    notice.textContent = mediaErrorMessage(status);
  });
}
