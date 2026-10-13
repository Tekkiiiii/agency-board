import type { ReactNode } from "react";

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  align?: "left" | "right" | "center";
  mono?: boolean; // machine values: ids, agent@machine, models, timestamps
  width?: string; // CSS width, e.g. "28%" or "120px"
  hideNarrow?: boolean; // hidden under 900px
  label?: string; // field label in stacked (narrow) rows; defaults to `header` when it is a string
}

// Plain semantic table: <caption>, <th scope="col">, first cell of each row can be a row header.
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  caption,
  captionVisible,
  empty,
  rowHeader,
  rowClassName,
  stack,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  caption: string;
  captionVisible?: boolean;
  empty?: ReactNode;
  rowHeader?: boolean; // first column rendered as <th scope="row">
  rowClassName?: (row: T) => string | undefined;
  stack?: boolean; // under 600px render each row as a labelled card (see .hub-table--stack)
}) {
  if (rows.length === 0 && empty) return <>{empty}</>;
  const labelOf = (c: Column<T>) => c.label ?? (typeof c.header === "string" ? c.header : "");
  const cellCls = (c: Column<T>) =>
    [c.mono && "hub-mono", c.align && c.align !== "left" && `hub-align-${c.align}`, c.hideNarrow && "hub-hide-narrow"]
      .filter(Boolean)
      .join(" ") || undefined;
  return (
    <div className="hub-table-wrap">
      <table className={stack ? "hub-table hub-table--stack" : "hub-table"}>
        <caption className={captionVisible ? "hub-table__caption" : "hub-sr-only"}>{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                style={c.width ? { width: c.width } : undefined}
                className={[c.align && c.align !== "left" && `hub-align-${c.align}`, c.hideNarrow && "hub-hide-narrow"].filter(Boolean).join(" ") || undefined}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={rowKey(r)} className={rowClassName?.(r)}>
              {columns.map((c, i) =>
                rowHeader && i === 0 ? (
                  <th key={c.key} scope="row" className={cellCls(c)}>
                    {c.render(r)}
                  </th>
                ) : (
                  <td key={c.key} className={cellCls(c)} data-label={stack ? labelOf(c) : undefined}>
                    {c.render(r)}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
