import { memo, useMemo } from "react";
import {
  Table,
  ColumnOrderState,
  VisibilityState,
} from "@tanstack/react-table";
import { IBaseRow, IBaseProperty } from "@/ee/base/types/base.types";
import { GridHeaderCell } from "./grid-header-cell";
import { CreatePropertyPopover } from "@/ee/base/components/property/create-property-popover";
import { useBaseEditable } from "@/ee/base/context/base-editable";
import classes from "@/ee/base/styles/grid.module.css";

type GridHeaderProps = {
  table: Table<IBaseRow>;
  pageId: string;
  columnOrder: ColumnOrderState;
  columnVisibility: VisibilityState;
  properties: IBaseProperty[];
  loadedRowIds: string[];
  onPropertyCreated?: () => void;
  getColumnOrder: () => string[];
  onColumnReorder?: (columnId: string, finishIndex: number) => void;
};

export const GridHeader = memo(function GridHeader({
  table,
  pageId,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  columnOrder: _columnOrder,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  columnVisibility: _columnVisibility,
  properties,
  loadedRowIds,
  onPropertyCreated,
  getColumnOrder,
  onColumnReorder,
}: GridHeaderProps) {
  const headerGroups = table.getHeaderGroups();
  const editable = useBaseEditable();
  const propertyById = useMemo(() => {
    const map = new Map<string, IBaseProperty>();
    for (const p of properties) map.set(p.id, p);
    return map;
  }, [properties]);

  return (
    <div className={classes.headerRow} role="row">
      {headerGroups[0]?.headers.map((header, headerIndex) => (
        <GridHeaderCell
          key={header.id}
          header={header}
          // Тот же счет, что и в теле строки: служебная колонка с номером
          // строки не нумеруется, остальные идут подряд. Без этого шапка
          // не объявляла индекс вовсе, а тело считало вместе со служебной.
          colIndex={
            header.column.id === "__row_number" ? undefined : headerIndex
          }
          property={propertyById.get(header.column.id)}
          loadedRowIds={loadedRowIds}
          pageId={pageId}
          getColumnOrder={getColumnOrder}
          onColumnReorder={onColumnReorder}
        />
      ))}
      {editable && (
        <CreatePropertyPopover
          pageId={pageId}
          properties={properties}
          onPropertyCreated={onPropertyCreated}
        />
      )}
    </div>
  );
});
