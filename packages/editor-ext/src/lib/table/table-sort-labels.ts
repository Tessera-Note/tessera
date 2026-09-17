/**
 * The labels of the sort arrows in a read-only table.
 *
 * The arrows are placed by the package itself (`table-readonly-sort.ts`), but
 * their labels are user-facing: they sit in `title`, `aria-label` and the
 * tooltip, which means a person reads them. The package knows nothing about
 * dictionaries, so the texts come from the application — the same way as the
 * labels of load failures (`media-error.ts`).
 *
 * Until they are set, the English defaults are used, so that the package stays
 * self-contained: it is shared with the earlier version, which has no
 * dictionary for it.
 */
export type TableSortLabels = {
  /** The column is unsorted: a click sorts it ascending. */
  ascending: string;
  /** Sorted ascending: a click reverses the order. */
  descending: string;
  /** Sorted descending: a click clears the sort. */
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
