import { describe, expect, it } from 'vitest';
import { chatDate, groupChatsByAge } from './grouping';
import type { Chat } from './services/chat';

/**
 * Даты строятся по местному времени исполнителя, а не строкой UTC.
 *
 * Разбивка считает границу от начала суток, и начало суток у неё местное.
 * Строка `...T23:50:00Z` в поясе Киева это уже следующий день, и проверка
 * границы разошлась бы с разбивкой не по существу, а по поясу.
 */
function at(year: number, month: number, day: number, hour = 12, minute = 0): string {
  return new Date(year, month - 1, day, hour, minute).toISOString();
}

const NOW = new Date(2026, 2, 15, 12, 0);
const t = (key: string) => key;

function chat(id: string, updatedAt: string | null): Chat {
  return { id, title: id, createdAt: updatedAt, updatedAt };
}

describe('groupChatsByAge', () => {
  it('пустой список не даёт разделов', () => {
    expect(groupChatsByAge([], t, NOW)).toEqual([]);
  });

  it('раскладывает по давности', () => {
    const groups = groupChatsByAge(
      [
        chat('сегодня', at(2026, 3, 15, 9)),
        chat('вчера', at(2026, 3, 14, 23, 50)),
        chat('на неделе', at(2026, 3, 11)),
        chat('в месяце', at(2026, 2, 25)),
        chat('давно', at(2025, 11, 1))
      ],
      t,
      NOW
    );

    expect(groups.map((one) => one.key)).toEqual([
      'today',
      'yesterday',
      'last7',
      'last30',
      'older'
    ]);
    expect(groups.map((one) => one.chats.map((c) => c.id))).toEqual([
      ['сегодня'],
      ['вчера'],
      ['на неделе'],
      ['в месяце'],
      ['давно']
    ]);
  });

  it('граница проходит по началу суток, а не по прошедшим суткам', () => {
    // Разговор в 23:50 вчера остаётся вчерашним и в 00:10 сегодня. По отсчёту
    // «сутки назад» он попал бы в «Сегодня».
    const midnight = new Date(2026, 2, 15, 0, 10);
    const groups = groupChatsByAge([chat('вчера', at(2026, 3, 14, 23, 50))], t, midnight);
    expect(groups.map((one) => one.key)).toEqual(['yesterday']);
  });

  it('пустые разделы не показываются', () => {
    const groups = groupChatsByAge([chat('сегодня', at(2026, 3, 15, 9))], t, NOW);
    expect(groups).toHaveLength(1);
  });

  it('разговор без даты не пропадает из списка', () => {
    const groups = groupChatsByAge([chat('без даты', null), chat('мусор', 'не дата')], t, NOW);
    expect(groups.map((one) => one.key)).toEqual(['older']);
    expect(groups[0].chats).toHaveLength(2);
  });
});

describe('chatDate', () => {
  it('сегодняшний показывается временем', () => {
    const shown = chatDate(at(2026, 3, 15, 9, 30), 'en-US', NOW);
    expect(shown).toMatch(/^\d{1,2}:\d{2}/);
  });

  it('этого года — днём и месяцем, без года', () => {
    expect(chatDate(at(2026, 1, 4), 'en-US', NOW)).toBe('Jan 4');
  });

  it('прошлого года — с годом', () => {
    expect(chatDate(at(2025, 11, 1), 'en-US', NOW)).toBe('Nov 1, 2025');
  });

  it('без даты и с испорченной датой не показывает ничего', () => {
    expect(chatDate(null, 'en-US', NOW)).toBe('');
    expect(chatDate(undefined, 'en-US', NOW)).toBe('');
    expect(chatDate('не дата', 'en-US', NOW)).toBe('');
  });
});
