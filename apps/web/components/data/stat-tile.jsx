'use client';

import { TrendingUp, TrendingDown } from 'lucide-react';
import { cn } from '@/lib/cn';
import { money, number, percent } from '@/lib/format';
import { Skeleton } from '@/components/ui/primitives';

const TONES = {
  neutral: 'text-[var(--text-primary)]',
  brand: 'text-[var(--color-brand-600)] dark:text-[var(--color-brand-400)]',
  positive: 'text-[var(--color-positive-600)] dark:text-[var(--color-positive-500)]',
  caution: 'text-[var(--color-caution-600)] dark:text-[var(--color-caution-500)]',
  critical: 'text-[var(--color-critical-600)] dark:text-[var(--color-critical-500)]',
};

/** The single number a person scans for first. Formatting lives here, once. */
export function StatTile({
  label, value, format = 'number', currency = 'INR', hint, delta,
  tone = 'neutral', icon: Icon, loading, className,
}) {
  const rendered =
    loading ? null
    : format === 'money' ? money(value, currency, { compact: Number(value) >= 100000 })
    : format === 'percent' ? percent(value)
    : format === 'raw' ? value
    : number(value);

  return (
    <div className={cn('panel p-4', className)}>
      <div className="flex items-start justify-between gap-2">
        <p className="truncate text-sm text-[var(--text-secondary)]">{label}</p>
        {Icon && <Icon className="size-4 shrink-0 text-[var(--text-disabled)]" strokeWidth={1.75} />}
      </div>

      {loading ? (
        <Skeleton className="mt-3 h-7 w-24" />
      ) : (
        <p className={cn('metric mt-2 text-2xl font-semibold tracking-[-0.025em]', TONES[tone])}>
          {rendered}
        </p>
      )}

      {(hint || delta !== undefined) && !loading && (
        <div className="mt-1.5 flex items-center gap-1.5 text-xs">
          {delta !== undefined && delta !== null && (
            <span
              className={cn(
                'inline-flex items-center gap-0.5 font-medium tabular',
                delta >= 0 ? 'text-[var(--color-positive-600)]' : 'text-[var(--color-critical-600)]',
              )}
            >
              {delta >= 0 ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
              {Math.abs(delta)}%
            </span>
          )}
          {hint && <span className="truncate text-[var(--text-tertiary)]">{hint}</span>}
        </div>
      )}
    </div>
  );
}
