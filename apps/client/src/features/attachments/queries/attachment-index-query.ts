import { useQuery } from "@tanstack/react-query";
import { getAttachmentInfo } from "@/features/page/services/page-service";

/**
 * Попадёт ли вложение в поиск.
 *
 * Извлечение текста берёт обычный текст, markdown, json, PDF и DOCX.
 * Картинка, архив или PDF из сканов не попадут в поиск никогда, и человек об
 * этом не знал: отметка была видна только администратору, в счёте по
 * состояниям.
 *
 * Правило живёт на сервере, здесь читается его результат. Повторять список
 * типов на клиенте значило бы завести второе правило, которое разойдётся с
 * первым.
 */
const INDEX_STATUS_STALE_MS = 5 * 60 * 1000;

export function useAttachmentIndexStatus(attachmentId?: string) {
  return useQuery({
    queryKey: ["attachment-index-status", attachmentId],
    queryFn: async () => (await getAttachmentInfo(attachmentId)).indexStatus,
    enabled: !!attachmentId,
    staleTime: INDEX_STATUS_STALE_MS,
    retry: false,
  });
}
