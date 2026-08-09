import { useQuery } from "@tanstack/react-query";
import { resolveMentions } from "@/features/user/services/user-service";
import { IMentionTarget } from "@/features/user/types/user.types";

/**
 * Кто стоит за упоминанием прямо сейчас.
 *
 * Подпись в узле упоминания заморожена на момент вставки, поэтому удаленный,
 * отключенный и действующий человек выглядели одинаково, а имя удаленного
 * оставалось в теле каждой страницы, где его упомянули: обезличивание при
 * удалении до содержимого не доходило.
 *
 * Ответ живет долго: имя меняется редко, а упоминаний на странице бывает
 * много. Один и тот же человек в кеше один, поэтому повторы бесплатны.
 */
const MENTION_STALE_MS = 5 * 60 * 1000;

export function useMentionUserQuery(userId?: string) {
  return useQuery<IMentionTarget | null>({
    queryKey: ["mention-user", userId],
    queryFn: async () => {
      const found = await resolveMentions([userId]);
      // Пусто означает, что записи больше нет: удалена или принадлежит другому
      // рабочему пространству. Различать эти случаи наружу незачем.
      return found[0] ?? null;
    },
    enabled: !!userId,
    staleTime: MENTION_STALE_MS,
    retry: false,
  });
}
