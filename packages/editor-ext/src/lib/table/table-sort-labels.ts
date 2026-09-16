/**
 * Подписи стрелок сортировки в таблице только для чтения.
 *
 * Стрелки ставит сам пакет (`table-readonly-sort.ts`), а подписи у них
 * пользовательские: они стоят в `title`, `aria-label` и всплывающей подсказке,
 * то есть их читает человек. Пакет про словари не знает, поэтому тексты
 * приходят из приложения — так же сделано для подписей отказов загрузки
 * (`media-error.ts`).
 *
 * До установки берутся английские значения по умолчанию, чтобы пакет оставался
 * самостоятельным: он общий с первой версией, и там словаря для него нет.
 */
export type TableSortLabels = {
  /** Столбец не отсортирован: нажатие отсортирует по возрастанию. */
  ascending: string;
  /** Отсортирован по возрастанию: нажатие развернёт порядок. */
  descending: string;
  /** Отсортирован по убыванию: нажатие снимет сортировку. */
  clear: string;
};

let labels: TableSortLabels = {
  ascending: 'Sort ascending',
  descending: 'Sort descending',
  clear: 'Clear sort',
};

export function setTableSortLabels(next: TableSortLabels): void {
  labels = next;
}

export function getTableSortLabels(): TableSortLabels {
  return labels;
}
