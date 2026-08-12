import { describe, expect, it } from 'vitest';
import { messageKey, splitBold } from './message';
import type { Notification } from './services/notifications';

function make(type: string, data: Record<string, unknown> | null = null): Notification {
  return {
    id: 'n',
    type,
    actorId: null,
    pageId: null,
    spaceId: null,
    commentId: null,
    data,
    readAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    actor: null,
    page: null,
    space: null
  };
}

describe('messageKey', () => {
  it('различает выданный доступ на чтение и на правку', () => {
    // Одна строка на оба случая означала бы, что человек не знает, дали ему
    // править или только смотреть.
    expect(messageKey(make('page.permission_granted', { role: 'writer' }))).toContain('edit');
    expect(messageKey(make('page.permission_granted', { role: 'reader' }))).toContain('view');
  });

  it('незнакомый вид не роняет экран', () => {
    expect(messageKey(make('page.something_new'))).toBe('');
  });

  it('ключи совпадают со словарём', async () => {
    // Ключ словаря это сама английская фраза. Опечатка в нём даёт строку с
    // угловыми скобками на экране, и заметить это можно только глазами.
    const dictionary = await import('../../../../static/locales/en-US.json');
    const types = [
      'comment.user_mention',
      'comment.created',
      'comment.resolved',
      'page.user_mention',
      'page.updated',
      'page.verified',
      'page.approval_requested',
      'page.approval_rejected',
      'page.verification_expiring',
      'page.verification_expired'
    ];
    const keys = [
      ...types.map((type) => messageKey(make(type))),
      messageKey(make('page.permission_granted', { role: 'writer' })),
      messageKey(make('page.permission_granted', { role: 'reader' }))
    ];
    expect(keys.every((key) => key.length > 0)).toBe(true);
    for (const key of keys) {
      expect(Object.keys(dictionary.default)).toContain(key);
    }
  });
});

describe('splitBold', () => {
  it('выделяет имя в отдельную часть', () => {
    expect(splitBold('<bold>Иван</bold> оставил комментарий')).toEqual([
      '',
      'Иван',
      ' оставил комментарий'
    ]);
  });

  it('строка без разметки остаётся целой', () => {
    expect(splitBold('Проверка страницы истекает')).toEqual(['Проверка страницы истекает', '', '']);
  });

  it('разметка в середине не теряет начало', () => {
    expect(splitBold('до <bold>имя</bold> после')).toEqual(['до ', 'имя', ' после']);
  });
});
