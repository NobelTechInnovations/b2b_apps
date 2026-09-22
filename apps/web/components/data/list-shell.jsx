'use client';

import { Search, SlidersHorizontal, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { Badge } from '@/components/ui/primitives';

/**
 * The chrome every list screen shares: search, filters, active-filter chips
 * and pagination. Written once so CRM, HR, Inventory and the rest look and
 * behave identically rather than each inventing its own toolbar.
 */
export function ListToolbar({
  search, onSearch, searchPlaceholder = 'Search…',
  filters = [], values = {}, onFilter, onClear,
  actions, children,
}) {
  const active = filters.filter((f) => values[f.key] !== undefined && values[f.key] !== '');

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          icon={Search}
          placeholder={searchPlaceholder}
          value={search ?? ''}
          onChange={(e) => onSearch?.(e.target.value)}
          className="w-full max-w-xs"
          suffix={
            search ? (
              <button
                onClick={() => onSearch?.('')}
                className="rounded p-0.5 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                aria-label="Clear search"
              >
                <X className="size-3.5" />
              </button>
            ) : null
          }
        />

        {filters.map((filter) => (
          <Select
            key={filter.key}
            value={values[filter.key] ?? ''}
            onChange={(e) => onFilter?.(filter.key, e.target.value || undefined)}
            className="w-auto min-w-[9rem]"
            aria-label={filter.label}
          >
            <option value="">{filter.label}: All</option>
            {filter.options.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </Select>
        ))}

        {children}

        <div className="flex-1" />
        {actions}
      </div>

      {active.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <SlidersHorizontal className="size-3.5 text-[var(--text-tertiary)]" />
          {active.map((filter) => {
            const option = filter.options.find((o) => String(o.value) === String(values[filter.key]));
            return (
              <button key={filter.key} onClick={() => onFilter?.(filter.key, undefined)}>
                <Badge tone="brand" className="gap-1 pr-1.5 hover:opacity-80">
                  {filter.label}: {option?.label ?? values[filter.key]}
                  <X className="size-3" />
                </Badge>
              </button>
            );
          })}
          <button
            onClick={onClear}
            className="ml-1 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            Clear all
          </button>
        </div>
      )}
    </div>
  );
}

export function Pagination({ meta, onPage, className }) {
  if (!meta || meta.total === 0) return null;

  const { page, pages, total, limit } = meta;
  const from = (page - 1) * limit + 1;
  const to = Math.min(page * limit, total);

  return (
    <div className={cn('flex items-center justify-between gap-4 pt-3', className)}>
      <p className="text-sm tabular text-[var(--text-secondary)]">
        {from}–{to} of {total}
      </p>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
          aria-label="Previous page"
        >
          <ChevronLeft className="size-4" />
        </Button>
        <span className="px-2 text-sm tabular text-[var(--text-secondary)]">
          {page} / {pages}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={page >= pages}
          onClick={() => onPage(page + 1)}
          aria-label="Next page"
        >
          <ChevronRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}
