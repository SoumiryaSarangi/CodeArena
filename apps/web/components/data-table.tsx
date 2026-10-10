'use client';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface Column<T> {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  /** Provide to make the column sortable. */
  sortValue?: (row: T) => string | number;
  align?: 'left' | 'right';
  mono?: boolean;
  /** Not shown under 768 px; the row's first cell carries what matters (see PracticeList). */
  hideOnPhone?: boolean;
}

/**
 * Dense 36 px rows, sticky header, `aria-sort`, and row navigation with ↑/↓ (Enter opens).
 * Virtualisation for > 200 rows (UI_UX §7) is added by the first screen that needs it.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onOpen,
  caption,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onOpen?: (row: T) => void;
  caption: string;
}) {
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(null);
  const body = useRef<HTMLTableSectionElement>(null);

  const sorted = useMemo(() => {
    const col = columns.find((c) => c.key === sort?.key);
    if (!sort || !col?.sortValue) return rows;
    const val = col.sortValue;
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      return (x < y ? -1 : x > y ? 1 : 0) * dir;
    });
  }, [rows, columns, sort]);

  const toggle = (key: string) =>
    setSort((s) =>
      s?.key === key ? (s.dir === 'asc' ? { key, dir: 'desc' } : null) : { key, dir: 'asc' },
    );

  const onRowKey = (e: KeyboardEvent<HTMLTableRowElement>, row: T) => {
    const trs = Array.from(body.current?.querySelectorAll<HTMLTableRowElement>('tr') ?? []);
    const i = trs.indexOf(e.currentTarget);
    if (e.key === 'ArrowDown') trs[i + 1]?.focus();
    else if (e.key === 'ArrowUp') trs[i - 1]?.focus();
    else if (e.key === 'Enter' && onOpen) onOpen(row);
    else return;
    e.preventDefault();
  };

  return (
    <div className="relative relative overflow-x-auto rounded-lg border border-border-strong">
      <table className="w-full border-collapse text-13">
        <caption className="sr-only">{caption}</caption>
        <thead className="sticky top-0 bg-surface-2">
          <tr>
            {columns.map((c) => {
              const active = sort?.key === c.key;
              return (
                <th
                  key={c.key}
                  scope="col"
                  aria-sort={
                    active
                      ? sort.dir === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : c.sortValue
                        ? 'none'
                        : undefined
                  }
                  className={cn(
                    'h-9 px-3 font-medium text-text-2',
                    c.align === 'right' ? 'text-right' : 'text-left',
                    c.hideOnPhone && 'max-md:hidden',
                  )}
                >
                  {c.sortValue ? (
                    <button
                      type="button"
                      onClick={() => toggle(c.key)}
                      className="inline-flex items-center gap-1 hover:text-text"
                    >
                      {c.header}
                      {active ? (
                        sort.dir === 'asc' ? (
                          <ArrowUp className="size-3" aria-hidden />
                        ) : (
                          <ArrowDown className="size-3" aria-hidden />
                        )
                      ) : null}
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody ref={body}>
          {sorted.map((row) => (
            <tr
              key={rowKey(row)}
              tabIndex={0}
              onKeyDown={(e) => onRowKey(e, row)}
              onClick={onOpen ? () => onOpen(row) : undefined}
              className={cn(
                'h-9 border-t border-border hover:bg-surface-2',
                onOpen && 'cursor-pointer',
              )}
            >
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={cn(
                    'px-3',
                    c.align === 'right' && 'text-right',
                    c.mono && 'font-mono tabular-nums',
                    c.hideOnPhone && 'max-md:hidden',
                  )}
                >
                  {c.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
