/**
 * Цвета текста и заливки.
 *
 * Значения те же, что в v1. Совпадение обязательно: цвет пишется в документ
 * шестнадцатеричным кодом, и другой набор означал бы, что страница, покрашенная
 * в первой версии, во второй красится иначе — а страницы у них общие.
 *
 * Имена английские и переводятся при показе: это ключи словаря.
 */

export type Swatch = { name: string; color: string };

/** Пустой цвет снимает окраску: так же его понимает `unsetColor`. */
export const TEXT_COLORS: readonly Swatch[] = [
  { name: 'Default', color: '' },
  { name: 'Blue', color: '#2563EB' },
  { name: 'Green', color: '#008A00' },
  { name: 'Purple', color: '#9333EA' },
  { name: 'Red', color: '#E00000' },
  { name: 'Yellow', color: '#EAB308' },
  { name: 'Orange', color: '#FFA500' },
  { name: 'Pink', color: '#BA4081' },
  { name: 'Gray', color: '#A8A29E' },
  { name: 'Brown', color: '#92400E' }
];

export const HIGHLIGHT_COLORS: readonly Swatch[] = [
  { name: 'Default', color: '' },
  { name: 'Blue', color: '#98d8f2' },
  { name: 'Green', color: '#7edb6c' },
  { name: 'Purple', color: '#e0d6ed' },
  { name: 'Red', color: '#ffc6c2' },
  { name: 'Yellow', color: '#faf594' },
  { name: 'Orange', color: '#f5c8a9' },
  { name: 'Pink', color: '#f5cfe0' },
  { name: 'Gray', color: '#dfdfd7' },
  { name: 'Brown', color: '#d7c4b7' }
];
