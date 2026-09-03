/**
 * Состояние подбора по знаку: что показывать, где и что делать по выбору.
 *
 * Отдельно от разметки, потому что источников три и они разные. Блоки берутся
 * из опции в памяти, люди и страницы — двумя запросами к серверу, эмодзи — из
 * набора, читаемого по требованию. Разметке от этого различия достаётся один
 * перечень строк.
 */

import type { Editor } from '@tiptap/core';
import { blockActions } from '../actions';
import { blockIcon } from '../block-icons';
import { BLOCKS, findBlocks, type Block, type BlockContext } from '../blocks';
import { emojiSet, findEmoji, rememberEmoji } from '../emoji';
import { searchPages } from '$lib/features/search/services/search';
// Подсказки людей уже есть в службе пространств: маршрут один, и второй
// вызов того же маршрута расходился бы с ним при первой же правке.
import { suggest } from '$lib/features/space/services/spaces';
import {
  EMOJI,
  MENTION,
  SLASH,
  moveSelection,
  readTrigger,
  type SuggestItem,
  type SuggestState,
  type Trigger,
  type TriggerRule
} from '../suggest';
import { IconFileDescription, IconUser } from '@tabler/icons-svelte';

/** Строка перечня вместе с тем, что она делает. */
type Choice = { item: SuggestItem; run: (trigger: Trigger) => void };

/** Полный набор знаков. Столько их у страницы; у комментария меньше. */
export const ALL_RULES = [SLASH, MENTION, EMOJI];

/**
 * Пауза перед запросом к серверу.
 *
 * Без неё каждый набранный знак это запрос: «@александр» стоил бы девяти.
 */
const DEBOUNCE_MS = 150;

/** Что нужно подбору сверх самого редактора. */
export type SuggestNeeds = {
  editor: Editor;
  pageId: string;
  spaceId: string | null;
  /** Кто вставляет упоминание. Пишется в узел, как в v1. */
  userId: string | null;
  locale: string;
  translate: (key: string) => string;
  fail: (error: unknown) => void;
  /**
   * Какие знаки разбирать.
   *
   * У комментария их два: «/» вставляет блоки, которых в схеме комментария нет
   * вовсе, и перечень предлагал бы то, что вставить некуда.
   */
  rules?: readonly TriggerRule[];
  /**
   * Какие блоки предлагать по «/».
   *
   * Умолчание — все. У шаблона перечень короче: страницы у него нет, и
   * загрузка файла с встраиванием базы отказали бы при нажатии.
   */
  blocks?: readonly Block[];
};

export class Suggest {
  open = $state(false);
  index = $state(0);
  loading = $state(false);
  at = $state({ left: 0, top: 0, bottom: 0 });
  choices = $state<Choice[]>([]);

  readonly items = $derived(this.choices.map((choice) => choice.item));

  /** Что показывать, когда ничего не нашлось. Зависит от знака. */
  empty = $state('');

  #needs: SuggestNeeds;
  #rules: readonly TriggerRule[];
  #trigger: Trigger | null = null;
  /** Номер запроса. Ответ на устаревший запрос отбрасывается. */
  #turn = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(needs: SuggestNeeds) {
    this.#needs = needs;
    this.#rules = needs.rules ?? ALL_RULES;
  }

  /** Перечитать состояние документа. Зовётся на каждой правке и движении каретки. */
  refresh(): void {
    const editor = this.#needs.editor;
    if (!editor.isEditable) {
      this.close();
      return;
    }

    const found = readTrigger(editor.state as unknown as SuggestState, this.#rules);
    if (!found) {
      this.close();
      return;
    }

    const same =
      this.#trigger?.char === found.char &&
      this.#trigger?.query === found.query &&
      this.#trigger?.from === found.from;
    this.#trigger = found;
    this.#place(found);
    if (same) return;

    this.index = 0;
    this.open = true;
    void this.#fill(found);
  }

  close(): void {
    this.#trigger = null;
    this.open = false;
    this.loading = false;
    this.choices = [];
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * Разобрать нажатие клавиши.
   *
   * Возвращает `true`, когда нажатие обработано: вызывающий гасит его, иначе
   * стрелка вниз уводит каретку из документа, а Enter заводит новый абзац
   * вместо выбора строки.
   */
  keydown(event: KeyboardEvent): boolean {
    if (!this.open) return false;

    if (event.key === 'Escape') {
      this.close();
      return true;
    }
    if (event.key === 'ArrowDown') {
      this.index = moveSelection(this.index, this.choices.length, 1);
      return true;
    }
    if (event.key === 'ArrowUp') {
      this.index = moveSelection(this.index, this.choices.length, -1);
      return true;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      // Пустой перечень нажатие не забирает: человек дописывает текст, а не
      // выбирает, и Enter должен завести абзац.
      if (this.choices.length === 0) return false;
      this.pick(this.index);
      return true;
    }
    return false;
  }

  /** Выбрать строку. Отрезок с запросом заменяется тем, что она вставляет. */
  pick(at: number): void {
    const choice = this.choices[at];
    const trigger = this.#trigger;
    if (!choice || !trigger) return;
    this.close();
    choice.run(trigger);
  }

  hover(at: number): void {
    this.index = at;
  }

  /** Поставить перечень под знаком-запятнателем. */
  #place(trigger: Trigger): void {
    const box = this.#needs.editor.view.coordsAtPos(trigger.from);
    this.at = { left: box.left, top: box.top, bottom: box.bottom };
  }

  async #fill(trigger: Trigger): Promise<void> {
    const turn = (this.#turn += 1);
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }

    if (trigger.char === SLASH.char) {
      this.empty = this.#needs.translate('No results');
      this.choices = this.#blocks(trigger);
      this.loading = false;
      return;
    }

    if (trigger.char === EMOJI.char) {
      this.empty = this.#needs.translate('No results');
      this.loading = true;
      const set = await emojiSet();
      if (turn !== this.#turn) return;
      this.loading = false;
      this.choices = findEmoji(trigger.query, set).map((row) => ({
        item: { key: row[1], label: row[1], glyph: row[0] },
        run: (found) => this.#insertEmoji(found, row[0], row[1])
      }));
      return;
    }

    this.empty = this.#needs.translate('No results');
    this.loading = true;
    this.choices = [];
    this.#timer = setTimeout(() => {
      void this.#people(trigger, turn);
    }, DEBOUNCE_MS);
  }

  #blocks(trigger: Trigger): Choice[] {
    const needs = this.#needs;
    return findBlocks(trigger.query, needs.translate, needs.blocks ?? BLOCKS).map((block) => ({
      item: { key: block.id, label: needs.translate(block.label), icon: blockIcon(block.id) },
      run: (found) => {
        const context: BlockContext = {
          editor: needs.editor,
          pageId: needs.pageId,
          range: { from: found.from, to: found.to },
          locale: needs.locale,
          fail: needs.fail,
          ...blockActions(needs.editor, needs.pageId, needs.fail)
        };
        block.run(context);
      }
    }));
  }

  /**
   * Люди и страницы двумя запросами.
   *
   * Порядок как в v1: сначала люди, потом страницы. Маршрут подсказок отдаёт
   * только людей и группы, страницы ищутся поиском — разными запросами, потому
   * что разными их держит сервер.
   */
  async #people(trigger: Trigger, turn: number): Promise<void> {
    const needs = this.#needs;
    try {
      const [people, pages] = await Promise.all([
        suggest(trigger.query),
        trigger.query ? searchPages(trigger.query, needs.spaceId) : Promise.resolve([])
      ]);
      if (turn !== this.#turn) return;

      const found: Choice[] = [];
      for (const person of people.users) {
        found.push({
          item: {
            key: `user:${person.id}`,
            label: person.name ?? person.email,
            hint: person.name ? person.email : undefined,
            icon: IconUser
          },
          run: (at) =>
            this.#insertMention(at, {
              label: person.name ?? person.email,
              entityType: 'user',
              entityId: person.id,
              slugId: null
            })
        });
      }
      for (const page of pages) {
        found.push({
          item: {
            key: `page:${page.id}`,
            label: page.title ?? needs.translate('Untitled'),
            icon: IconFileDescription
          },
          run: (at) =>
            this.#insertMention(at, {
              label: page.title ?? needs.translate('Untitled'),
              entityType: 'page',
              entityId: page.id,
              slugId: page.slugId
            })
        });
      }

      this.choices = found;
    } catch (error) {
      if (turn !== this.#turn) return;
      this.choices = [];
      needs.fail(error);
    } finally {
      if (turn === this.#turn) this.loading = false;
    }
  }

  #insertMention(
    trigger: Trigger,
    attributes: {
      label: string;
      entityType: 'user' | 'page';
      entityId: string;
      slugId: string | null;
    }
  ): void {
    this.#needs.editor
      .chain()
      .focus()
      .insertContentAt({ from: trigger.from, to: trigger.to }, [
        {
          type: 'mention',
          attrs: {
            // Своё имя у каждой вставки: по нему сервер отличает новое
            // упоминание от уже разосланного и не шлёт извещение дважды.
            id: crypto.randomUUID(),
            creatorId: this.#needs.userId,
            ...attributes
          }
        },
        { type: 'text', text: ' ' }
      ])
      .run();
  }

  #insertEmoji(trigger: Trigger, native: string, id: string): void {
    rememberEmoji(id);
    this.#needs.editor
      .chain()
      .focus()
      .insertContentAt({ from: trigger.from, to: trigger.to }, `${native} `)
      .run();
  }
}
