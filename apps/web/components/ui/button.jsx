'use client';

import { forwardRef } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/cn';

const VARIANTS = {
  primary:
    'bg-[var(--color-brand-600)] text-white shadow-xs hover:bg-[var(--color-brand-700)] active:bg-[var(--color-brand-800)] disabled:bg-[var(--color-brand-300)]',
  secondary:
    'bg-[var(--surface-raised)] text-[var(--text-primary)] border border-[var(--border-default)] shadow-xs hover:bg-[var(--surface-hover)] active:bg-[var(--surface-active)]',
  ghost:
    'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] active:bg-[var(--surface-active)]',
  subtle:
    'bg-[var(--surface-sunken)] text-[var(--text-primary)] hover:bg-[var(--surface-active)]',
  danger:
    'bg-[var(--color-critical-600)] text-white shadow-xs hover:bg-[var(--color-critical-700)]',
  'danger-ghost':
    'text-[var(--color-critical-600)] hover:bg-[var(--color-critical-50)] dark:hover:bg-[rgb(239_68_68/0.1)]',
  link: 'text-[var(--text-brand)] hover:underline underline-offset-4 px-0',
};

const SIZES = {
  xs: 'h-7 px-2 text-xs gap-1.5 rounded-[var(--radius-sm)]',
  sm: 'h-8 px-2.5 text-sm gap-1.5 rounded-[var(--radius-md)]',
  md: 'h-9 px-3.5 text-base gap-2 rounded-[var(--radius-md)]',
  lg: 'h-10 px-4 text-md gap-2 rounded-[var(--radius-lg)]',
  xl: 'h-11 px-5 text-md gap-2 rounded-[var(--radius-lg)]',
  icon: 'h-8 w-8 rounded-[var(--radius-md)]',
  'icon-sm': 'h-7 w-7 rounded-[var(--radius-sm)]',
};

export const Button = forwardRef(function Button(
  { variant = 'secondary', size = 'md', loading, icon: Icon, iconRight: IconRight, className, children, disabled, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        'inline-flex select-none items-center justify-center whitespace-nowrap font-medium',
        'transition-[background-color,box-shadow,transform] duration-150',
        'active:scale-[0.985] disabled:pointer-events-none disabled:opacity-60',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    >
      {loading ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        Icon && <Icon className={size === 'xs' ? 'size-3.5' : 'size-4'} strokeWidth={2} />
      )}
      {children}
      {IconRight && !loading && <IconRight className="size-4" strokeWidth={2} />}
    </button>
  );
});
