/**
 * Разговоры по давности.
 *
 * Плоский список из полусотни названий не даёт найти вчерашний разговор: все
 * строки одинаковы и порядок в них ничего не сообщает. В v1 список разбит на
 * «Сегодня», «Вчера», «Последние 7 дней», «Последние 30 дней» и «Раньше»
 * (`ee/ai-chat/utils/group-chats-by-age.ts`), и у каждой строки стоит время.
 *
 * Границы считаются от начала суток, а не «сутки назад»: разговор в 23:50
 * вчера должен попасть во «Вчера» и в 00:10 сегодня, а не в «Сегодня».
 */

import type { Chat } from './services/chat';

export type ChatGroup = { key: string; label: string; chats: Chat[] };

const DAY_MS = 24 * 60 * 60 * 1000;

/** Разбивка списка. Пустые разделы не возвращаются. */
export function groupChatsByAge(
  chats: Chat[],
  t: (key: string) => string,
  now: Date = new Date()
): ChatGroup[] {
  if (chats.length === 0) return [];

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - DAY_MS;
  const startOfLast7 = startOfToday - 7 * DAY_MS;
  const startOfLast30 = startOfToday - 30 * DAY_MS;

  const buckets: ChatGroup[] = [
    { key: 'today', label: t('Today'), chats: [] },
    { key: 'yesterday', label: t('Yesterday'), chats: [] },
    { key: 'last7', label: t('Previous 7 days'), chats: [] },
    { key: 'last30', label: t('Previous 30 days'), chats: [] },
    { key: 'older', label: t('Older'), chats: [] }
  ];

  for (const chat of chats) {
    const at = chat.updatedAt ? new Date(chat.updatedAt).getTime() : Number.NaN;
    // Разговор без даты и с испорченной датой уходит в «Раньше»: потерять
    // строку из списка хуже, чем показать её не в том разделе.
    if (Number.isNaN(at) || at < startOfLast30) buckets[4].chats.push(chat);
    else if (at >= startOfToday) buckets[0].chats.push(chat);
    else if (at >= startOfYesterday) buckets[1].chats.push(chat);
    else if (at >= startOfLast7) buckets[2].chats.push(chat);
    else buckets[3].chats.push(chat);
  }

  return buckets.filter((one) => one.chats.length > 0);
}

/**
 * Время разговора в строке списка.
 *
 * Сегодняшний — часами, этого года — днём и месяцем, старше — с годом. Полная
 * дата у каждой строки занимает место, которого в боковой панели нет.
 */
export function chatDate(
  value: string | null | undefined,
  language: string,
  now: Date = new Date()
): string {
  if (!value) return '';
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return '';

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

  if (at.getTime() >= startOfToday) {
    return at.toLocaleTimeString(language, { hour: 'numeric', minute: '2-digit' });
  }
  if (at.getFullYear() === now.getFullYear()) {
    return at.toLocaleDateString(language, { month: 'short', day: 'numeric' });
  }
  return at.toLocaleDateString(language, { month: 'short', day: 'numeric', year: 'numeric' });
}
