'use client';

import { cn } from '@/lib/cn';
import { Skeleton } from './primitives';

/**
 * A dense data table. Rows are 40px, numbers are tabular, the header sticks,
 * and hover is subtle — this is a surface people scan for hours.
 */
export function Table({ children, className }) {
  return (
    <div className="overflow-x-auto rounded-[var(--radius-xl)] border border-[var(--border-subtle)] bg-[var(--surface-raised)]">
      <table className={cn('w-full border-collapse text-base', className)}>{children}</table>
    </div>
  );
}

export const THead = ({ children }) => (
  <thead className="sticky top-0 z-10 bg-[var(--surface-raised)]">{children}</thead>
);

export const TBody = ({ children }) => <tbody>{children}</tbody>;

export function TH({ children, align = 'left', width, className, sortable, sorted, onSort }) {
  return (
    <th
      style={{ width }}
      className={cn(
        'border-b border-[var(--border-subtle)] px-3.5 py-2.5 text-xs font-medium text-[var(--text-tertiary)]',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        align === 'left' && 'text-left',
        sortable && 'cursor-pointer select-none hover:text-[var(--text-primary)]',
        className,
      )}
      onClick={sortable ? onSort : undefined}
      aria-sort={sorted ? (sorted === 'asc' ? 'ascending' : 'descending') : undefined}
    >
      <span className="inline-flex items-center gap-1">
        {children}
        {sorted && <span className="text-[10px]">{sorted === 'asc' ? '▲' : '▼'}</span>}
      </span>
    </th>
  );
}

export function TR({ children, onClick, className, selected }) {
  return (
    <tr
      onClick={onClick}
      className={cn(
        'border-b border-[var(--border-subtle)] last:border-0',
        onClick && 'cursor-pointer',
        'transition-colors duration-100 hover:bg-[var(--surface-hover)]',
        selected && 'bg-[var(--color-brand-50)] dark:bg-[rgb(99_102_241/0.08)]',
        className,
      )}
    >
      {children}
    </tr>
  );
}

export function TD({ children, align = 'left', className, numeric }) {
  return (
    <td
      className={cn(
        'px-3.5 py-2.5 align-middle',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        numeric && 'tabular',
        className,
      )}
    >
      {children}
    </td>
  );
}

export function TableSkeleton({ rows = 5, columns = 4 }) {
  return (
    <Table>
      <THead>
        <tr>
          {Array.from({ length: columns }).map((_, i) => (
            <TH key={i}><Skeleton className="h-3 w-20" /></TH>
          ))}
        </tr>
      </THead>
      <TBody>
        {Array.from({ length: rows }).map((_, r) => (
          <TR key={r}>
            {Array.from({ length: columns }).map((_, c) => (
              <TD key={c}><Skeleton className={cn('h-4', c === 0 ? 'w-40' : 'w-24')} /></TD>
            ))}
          </TR>
        ))}
      </TBody>
    </Table>
  );
}
