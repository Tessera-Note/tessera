import { isAxiosError } from "axios";

export function getApiErrorMessage(
  error: unknown,
  fallback = "An error occurred",
): string {
  if (isAxiosError(error)) {
    const message = error.response?.data?.message;
    if (Array.isArray(message)) {
      const joined = message.filter(Boolean).join(", ");
      if (joined) return joined;
    } else if (typeof message === "string" && message.trim()) {
      return message;
    }
  }
  return fallback;
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
