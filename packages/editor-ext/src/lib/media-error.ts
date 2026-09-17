/**
 * Handling an unavailable attachment in the nodes drawn with plain DOM.
 *
 * The `image`, `video`, `drawio` and `excalidraw` nodes go through
 * `ResizableNodeView`, which sets `pointer-events: none` and a pulsing class on
 * the container until the load finishes. That was removed **only** in the
 * successful-load handler, so on a 404 or a 403 the node stayed a pulsing
 * placeholder forever: it could not be selected with the mouse, dragged, or
 * opened from the menu. The state is purely runtime and nothing of it is stored
 * in the content, so it clears itself as soon as the node is rendered by this
 * code.
 *
 * The texts come from the application: the extensions package knows nothing
 * about i18next, while user-facing strings must go through it. Until they are
 * set, the English defaults are used, so that the package stays
 * self-contained.
 */
export type MediaErrorLabels = {
  /** The file is gone: 404. */
  missing: string;
  /** The file exists, access does not: 403. */
  forbidden: string;
  /** Everything else, a dropped connection included. */
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
 * The response code for an address that `img` or `video` failed to load.
 *
 * The tag says nothing about the reason, so the status is found out with a
 * separate request. It is made **only** after a failure, so it adds no cost to
 * the ordinary path.
 */
export async function resolveMediaErrorStatus(
  src: string,
): Promise<number | undefined> {
  try {
    const response = await fetch(src, {
      method: 'GET',
      credentials: 'include',
      // The response is needed only for its status; the body is not read.
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
 * Remove the block and show the reason.
 *
 * The order matters: the block is removed at once and does not wait for the
 * status request, otherwise the node would stay immovable for the round trip.
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
