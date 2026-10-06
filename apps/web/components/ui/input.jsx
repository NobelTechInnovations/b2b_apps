'use client';

import { forwardRef, useId, useState } from 'react';
import { Eye, EyeOff, AlertCircle, CircleHelp } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useAiHelp, askAboutField } from '@/lib/ai-help';

const base =
  'w-full bg-[var(--surface-raised)] text-[var(--text-primary)] placeholder:text-[var(--text-disabled)] ' +
  'border border-[var(--border-default)] rounded-[var(--radius-md)] ' +
  'transition-[box-shadow,border-color] duration-150 ' +
  'focus:border-[var(--border-focus)] focus:outline-none focus:shadow-[var(--ring-focus)] ' +
  'disabled:bg-[var(--surface-sunken)] disabled:text-[var(--text-disabled)]';

export const Input = forwardRef(function Input(
  { className, error, icon: Icon, suffix, size = 'md', ...props },
  ref,
) {
  const heights = { sm: 'h-8 text-sm', md: 'h-9 text-base', lg: 'h-10 text-md' };
  return (
    <div className="relative">
      {Icon && (
        <Icon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--text-tertiary)]" />
      )}
      <input
        ref={ref}
        className={cn(
          base,
          heights[size],
          Icon ? 'pl-9' : 'pl-3',
          suffix ? 'pr-10' : 'pr-3',
          error && 'border-[var(--color-critical-500)] focus:shadow-[0_0_0_3px_rgb(239_68_68/0.14)]',
          className,
        )}
        aria-invalid={error ? 'true' : undefined}
        {...props}
      />
      {suffix && <div className="absolute right-2.5 top-1/2 -translate-y-1/2">{suffix}</div>}
    </div>
  );
});

export const PasswordInput = forwardRef(function PasswordInput(props, ref) {
  const [visible, setVisible] = useState(false);
  return (
    <Input
      ref={ref}
      type={visible ? 'text' : 'password'}
      suffix={
        <button
          type="button"
          tabIndex={-1}
          onClick={() => setVisible((v) => !v)}
          className="rounded p-1 text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)]"
          aria-label={visible ? 'Hide password' : 'Show password'}
        >
          {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
      }
      {...props}
    />
  );
});

export function Textarea({ className, error, ...props }) {
  return (
    <textarea
      className={cn(base, 'min-h-20 resize-y px-3 py-2', error && 'border-[var(--color-critical-500)]', className)}
      {...props}
    />
  );
}

export function Select({ className, children, error, ...props }) {
  return (
    <select
      className={cn(base, 'h-9 cursor-pointer appearance-none bg-no-repeat px-3 pr-9', className)}
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' fill='none' stroke='%23667085' stroke-width='2' stroke-linecap='round'%3E%3Cpath d='m4 6 4 4 4-4'/%3E%3C/svg%3E\")",
        backgroundPosition: 'right 10px center',
      }}
      {...props}
    >
      {children}
    </select>
  );
}

/** Label + control + hint/error, with the ids wired up. */
export function Field({ label, hint, error, required, children, className }) {
  const id = useId();
  const aiHelp = useAiHelp();
  const child =
    typeof children === 'function'
      ? children({ id, 'aria-describedby': error ? `${id}-error` : hint ? `${id}-hint` : undefined })
      : children;

  return (
    <div className={cn('space-y-1.5', className)}>
      {label && (
        <div className="flex items-center gap-1.5"><label htmlFor={id} className="block text-sm font-medium text-[var(--text-primary)]">
          {label}
          {required && <span className="ml-0.5 text-[var(--color-critical-500)]">*</span>}
        </label>{aiHelp && typeof label === 'string' && <button type="button" aria-label={`Ask AI about ${label}`} title="Explain this field" onClick={() => askAboutField(label, hint)} className="rounded p-0.5 text-[var(--text-disabled)] hover:text-[var(--color-brand-600)]"><CircleHelp className="size-3.5" /></button>}</div>
      )}
      {child}
      {error ? (
        <p id={`${id}-error`} className="flex items-start gap-1.5 text-xs text-[var(--color-critical-600)]">
          <AlertCircle className="mt-px size-3.5 shrink-0" />
          <span>{error}</span>
        </p>
      ) : (
        hint && <p id={`${id}-hint`} className="text-xs text-[var(--text-tertiary)]">{hint}</p>
      )}
    </div>
  );
}

export function Checkbox({ label, description, className, ...props }) {
  return (
    <label className={cn('flex cursor-pointer items-start gap-2.5', className)}>
      <input
        type="checkbox"
        className="mt-0.5 size-4 shrink-0 cursor-pointer rounded-[var(--radius-xs)] border-[var(--border-strong)] text-[var(--color-brand-600)] focus:shadow-[var(--ring-focus)]"
        {...props}
      />
      <span className="min-w-0">
        {label && <span className="block text-base text-[var(--text-primary)]">{label}</span>}
        {description && <span className="block text-xs text-[var(--text-tertiary)]">{description}</span>}
      </span>
    </label>
  );
}
