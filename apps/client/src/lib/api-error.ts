import { isAxiosError } from "axios";
import i18n from "@/i18n";

/**
 * Отказ, пришедший с сервера, на языке читающего.
 *
 * Сервер отдает вместе с отказом устойчивый код, и этот же код служит ключом
 * перевода. Раньше показывался готовый текст с сервера, то есть человек с
 * любой из двенадцати локалей видел его на языке серверного кода, а
 * заведенный рядом ключ перевода не отображался почти никогда.
 *
 * Порядок предпочтения: перевод по коду, затем текст сервера, затем запасной
 * вариант вызывающего. Средняя ступень нужна для отказов, у которых кода еще
 * нет: их сообщение понятнее общего «произошла ошибка».
 */
export function getApiErrorMessage(error: unknown, fallback?: string): string {
  if (isAxiosError(error)) {
    const data = error.response?.data as
      | { code?: string; params?: Record<string, unknown>; message?: unknown }
      | undefined;

    if (typeof data?.code === "string") {
      const translated = i18n.t(data.code, {
        ...(data.params ?? {}),
        defaultValue: "",
      });
      if (translated) return translated;
    }

    const message = error.response?.data?.message;
    if (Array.isArray(message)) {
      const joined = message.filter(Boolean).join(", ");
      if (joined) return joined;
    } else if (typeof message === "string" && message.trim()) {
      return message;
    }
  }
  // Запасной вариант тоже переводится: он показывается человеку так же, как
  // и все остальное.
  return fallback ?? i18n.t("An error occurred");
}

/**
 * Код ответа, с которым упал запрос.
 *
 * Нужен там, где «объекта нет» и «нет прав» требуют разных слов. Общий текст
 * на оба случая отправляет человека проверять права, которых он и так не
 * менял, а настоящая причина остается ненайденной.
 */
export function getApiErrorStatus(error: unknown): number | undefined {
  return isAxiosError(error) ? error.response?.status : undefined;
}
