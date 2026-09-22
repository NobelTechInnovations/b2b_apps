'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { CheckCircle2, AlertTriangle, XCircle, Info, X } from 'lucide-react';
import { cn } from '@/lib/cn';

const ToastContext = createContext(null);

const TONES = {
  success: { icon: CheckCircle2, className: 'text-[var(--color-positive-600)]' },
  error: { icon: XCircle, className: 'text-[var(--color-critical-600)]' },
  warning: { icon: AlertTriangle, className: 'text-[var(--color-caution-600)]' },
  info: { icon: Info, className: 'text-[var(--color-info-600)]' },
};

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const dismiss = useCallback((id) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const push = useCallback((toast) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((current) => [...current.slice(-3), { id, ...toast }]);
    return id;
  }, []);

  const value = {
    toast: push,
    success: (title, options) => push({ tone: 'success', title, ...options }),
    error: (title, options) => push({ tone: 'error', title, duration: 7_000, ...options }),
    warning: (title, options) => push({ tone: 'warning', title, ...options }),
    info: (title, options) => push({ tone: 'info', title, ...options }),
    dismiss,
  };

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-full max-w-sm flex-col gap-2"
        role="region"
        aria-label="Notifications"
      >
        {toasts.map((toast) => (
          <Toast key={toast.id} {...toast} onDismiss={() => dismiss(toast.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function Toast({ tone = 'info', title, description, action, duration = 5_000, onDismiss }) {
  useEffect(() => {
    if (!duration) return undefined;
    const timer = setTimeout(onDismiss, duration);
    return () => clearTimeout(timer);
  }, [duration, onDismiss]);

  const { icon: Icon, className } = TONES[tone] ?? TONES.info;

  return (
    <div
      role="status"
      className={cn(
        'animate-rise pointer-events-auto flex items-start gap-3 rounded-[var(--radius-lg)]',
        'border border-[var(--border-subtle)] bg-[var(--surface-overlay)] p-3.5 shadow-[var(--shadow-pop)]',
      )}
    >
      <Icon className={cn('mt-px size-[18px] shrink-0', className)} />
      <div className="min-w-0 flex-1">
        <p className="text-base font-medium leading-tight">{title}</p>
        {description && <p className="mt-1 text-sm text-[var(--text-secondary)]">{description}</p>}
        {action && <div className="mt-2">{action}</div>}
      </div>
      <button
        onClick={onDismiss}
        aria-label="Dismiss"
        className="-m-1 rounded p-1 text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)]"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside <ToastProvider>');
  return context;
}
