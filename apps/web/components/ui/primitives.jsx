'use client';

import { cn } from '@/lib/cn';

/* ── card ─────────────────────────────────────────────────────────────────── */
export function Card({ className, children, interactive, ...props }) {
  return (
    <div
      className={cn(
        'rounded-[var(--radius-xl)] border border-[var(--border-subtle)] bg-[var(--surface-raised)] shadow-xs',
        interactive &&
          'cursor-pointer transition-[box-shadow,border-color,transform] duration-200 hover:-translate-y-px hover:border-[var(--border-default)] hover:shadow-md',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardHeader({ title, description, action, className }) {
  return (
    <div className={cn('flex items-start justify-between gap-4 px-5 pt-4 pb-3', className)}>
      <div className="min-w-0">
        <h3 className="truncate text-md font-semibold">{title}</h3>
        {description && <p className="mt-0.5 text-sm text-[var(--text-secondary)]">{description}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export const CardBody = ({ className, children }) => (
  <div className={cn('px-5 pb-5', className)}>{children}</div>
);

export const CardFooter = ({ className, children }) => (
  <div className={cn('flex items-center justify-end gap-2 border-t border-[var(--border-subtle)] px-5 py-3', className)}>
    {children}
  </div>
);

/* ── badge ────────────────────────────────────────────────────────────────── */
const TONES = {
  neutral: 'bg-[var(--surface-sunken)] text-[var(--text-secondary)] ring-[var(--border-subtle)]',
  brand: 'bg-[var(--color-brand-50)] text-[var(--color-brand-700)] ring-[var(--color-brand-200)] dark:bg-[rgb(99_102_241/0.12)] dark:text-[var(--color-brand-300)] dark:ring-[rgb(99_102_241/0.22)]',
  positive: 'bg-[var(--color-positive-50)] text-[var(--color-positive-700)] ring-[rgb(16_185_129/0.2)] dark:bg-[rgb(16_185_129/0.12)] dark:text-[var(--color-positive-500)]',
  caution: 'bg-[var(--color-caution-50)] text-[var(--color-caution-700)] ring-[rgb(245_158_11/0.2)] dark:bg-[rgb(245_158_11/0.12)] dark:text-[var(--color-caution-500)]',
  critical: 'bg-[var(--color-critical-50)] text-[var(--color-critical-700)] ring-[rgb(239_68_68/0.2)] dark:bg-[rgb(239_68_68/0.12)] dark:text-[var(--color-critical-500)]',
  info: 'bg-[var(--color-info-50)] text-[var(--color-info-600)] ring-[rgb(59_130_246/0.2)] dark:bg-[rgb(59_130_246/0.12)] dark:text-[rgb(147_197_253)]',
};

export function Badge({ tone = 'neutral', size = 'md', dot, className, children }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full font-medium ring-1 ring-inset',
        size === 'sm' ? 'px-1.5 py-0.5 text-2xs' : 'px-2 py-0.5 text-xs',
        TONES[tone],
        className,
      )}
    >
      {dot && <span className="size-1.5 rounded-full bg-current opacity-70" />}
      {children}
    </span>
  );
}

/* ── avatar ───────────────────────────────────────────────────────────────── */
const AVATAR_TINTS = [
  'bg-[#e0e7ff] text-[#4338ca]', 'bg-[#fce7f3] text-[#be185d]',
  'bg-[#d1fae5] text-[#047857]', 'bg-[#fef3c7] text-[#b45309]',
  'bg-[#e0f2fe] text-[#0369a1]', 'bg-[#ede9fe] text-[#6d28d9]',
  'bg-[#ffe4e6] text-[#be123c]', 'bg-[#ccfbf1] text-[#0f766e]',
];

const initials = (name = '') =>
  name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';

const tintFor = (seed = '') => {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_TINTS[hash % AVATAR_TINTS.length];
};

export function Avatar({ name, src, size = 'md', className, square }) {
  const sizes = {
    xs: 'size-5 text-2xs', sm: 'size-6 text-2xs', md: 'size-8 text-xs',
    lg: 'size-10 text-sm', xl: 'size-14 text-md',
  };

  if (src) {
    return (

      <img
        src={src}
        alt={name ?? ''}
        className={cn('shrink-0 object-cover ring-1 ring-[var(--border-subtle)]', square ? 'rounded-[var(--radius-md)]' : 'rounded-full', sizes[size], className)}
      />
    );
  }

  return (
    <span
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center font-semibold',
        square ? 'rounded-[var(--radius-md)]' : 'rounded-full',
        sizes[size], tintFor(name ?? ''), className,
      )}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}

/* ── layout bits ──────────────────────────────────────────────────────────── */
export function PageHeader({ title, description, actions, breadcrumb, className }) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-4 pb-6', className)}>
      <div className="min-w-0">
        {breadcrumb && <div className="mb-1.5 text-xs text-[var(--text-tertiary)]">{breadcrumb}</div>}
        <h1 className="text-xl font-semibold tracking-[-0.02em]">{title}</h1>
        {description && (
          <p className="mt-1 max-w-2xl text-base text-[var(--text-secondary)]">{description}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({ icon: Icon, title, description, action, className }) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-16 text-center', className)}>
      {Icon && (
        <div className="mb-4 flex size-12 items-center justify-center rounded-[var(--radius-xl)] bg-[var(--surface-sunken)] text-[var(--text-tertiary)]">
          <Icon className="size-6" strokeWidth={1.5} />
        </div>
      )}
      <h3 className="text-md font-semibold">{title}</h3>
      {description && (
        <p className="mt-1 max-w-sm text-base text-[var(--text-secondary)]">{description}</p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export const Skeleton = ({ className }) => <div className={cn('skeleton', className)} />;

export function Divider({ label, className }) {
  if (!label) return <hr className={cn('border-t border-[var(--border-subtle)]', className)} />;
  return (
    <div className={cn('flex items-center gap-3', className)}>
      <hr className="flex-1 border-t border-[var(--border-subtle)]" />
      <span className="text-xs font-medium text-[var(--text-tertiary)]">{label}</span>
      <hr className="flex-1 border-t border-[var(--border-subtle)]" />
    </div>
  );
}

export function Kbd({ children, className }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded-[var(--radius-xs)] border border-[var(--border-default)] bg-[var(--surface-sunken)] px-1 font-sans text-2xs font-medium text-[var(--text-tertiary)]',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

/* ── alert ────────────────────────────────────────────────────────────────── */
const ALERT_TONES = {
  info: 'bg-[var(--color-info-50)] text-[var(--color-info-600)] border-[rgb(59_130_246/0.2)] dark:bg-[rgb(59_130_246/0.08)]',
  positive: 'bg-[var(--color-positive-50)] text-[var(--color-positive-700)] border-[rgb(16_185_129/0.2)] dark:bg-[rgb(16_185_129/0.08)] dark:text-[var(--color-positive-500)]',
  caution: 'bg-[var(--color-caution-50)] text-[var(--color-caution-700)] border-[rgb(245_158_11/0.25)] dark:bg-[rgb(245_158_11/0.08)] dark:text-[var(--color-caution-500)]',
  critical: 'bg-[var(--color-critical-50)] text-[var(--color-critical-700)] border-[rgb(239_68_68/0.22)] dark:bg-[rgb(239_68_68/0.08)] dark:text-[rgb(252_165_165)]',
};

export function Alert({ tone = 'info', icon: Icon, title, children, action, className }) {
  return (
    <div className={cn('flex gap-3 rounded-[var(--radius-lg)] border px-3.5 py-3 text-sm', ALERT_TONES[tone], className)}>
      {Icon && <Icon className="mt-px size-4 shrink-0" />}
      <div className="min-w-0 flex-1">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className={cn(title && 'mt-0.5', 'opacity-90')}>{children}</div>}
      </div>
      {action}
    </div>
  );
}
