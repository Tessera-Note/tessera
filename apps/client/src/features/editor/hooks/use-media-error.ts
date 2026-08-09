import { useCallback, useState } from "react";
import {
  mediaErrorMessage,
  resolveMediaErrorStatus,
} from "@tessera/editor-ext";

/**
 * Сообщение о недоступном вложении для узлов, которые рисуются React.
 *
 * `image`, `video`, `drawio` и `excalidraw` идут через `ResizableNodeView` и
 * пользуются `handleMediaError` из пакета расширений. `audio` и `attachment`
 * рисуются React-представлениями, и обработчика у них не было вовсе: человек
 * видел нерабочий плеер без объяснения, а по кнопке загрузки открывался JSON
 * с ошибкой сервера.
 *
 * Причина отказа выясняется тем же способом: тег о ней ничего не сообщает,
 * поэтому статус запрашивается отдельно и **только** после отказа, то есть на
 * обычном пути стоимости не добавляет.
 */
export function useMediaError() {
  const [message, setMessage] = useState<string | null>(null);

  const report = useCallback(async (src: string | null | undefined) => {
    if (!src) {
      setMessage(mediaErrorMessage(undefined));
      return undefined;
    }

    const status = await resolveMediaErrorStatus(src);
    setMessage(mediaErrorMessage(status));
    return status;
  }, []);

  const clear = useCallback(() => setMessage(null), []);

  return { message, report, clear };
}
