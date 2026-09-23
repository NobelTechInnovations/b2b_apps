'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, ArrowRight, ArrowLeft, Sparkles } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';

/**
 * A guided tour that points at real elements.
 *
 * Steps target `data-tour="…"` attributes rather than CSS classes, so
 * restyling a component never silently breaks the tour. A step whose target
 * is not on the page is skipped instead of leaving an orphaned bubble —
 * which matters here, because the sidebar differs per customer depending on
 * which apps they bought.
 */
export function Tour({ steps, open, onClose, onFinish, storageKey }) {
  const [index, setIndex] = useState(0);
  const [spot, setSpot] = useState(null);
  const bubbleRef = useRef(null);

  // Only steps whose target actually exists for this workspace.
  const [live, setLive] = useState([]);

  useEffect(() => {
    if (!open) return;
    const present = steps.filter(
      (step) => !step.target || document.querySelector(`[data-tour="${step.target}"]`),
    );
    setLive(present);
    setIndex(0);
  }, [open, steps]);

  const step = live[index];

  const measure = useCallback(() => {
    if (!step) return;
    if (!step.target) { setSpot(null); return; }

    const element = document.querySelector(`[data-tour="${step.target}"]`);
    if (!element) { setSpot(null); return; }

    element.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const rect = element.getBoundingClientRect();
    const pad = step.padding ?? 8;

    setSpot({
      top: rect.top - pad,
      left: rect.left - pad,
      width: rect.width + pad * 2,
      height: rect.height + pad * 2,
    });
  }, [step]);

  useLayoutEffect(() => {
    if (!open) return undefined;
    measure();
    const timer = setTimeout(measure, 320); // after the smooth scroll settles
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [open, measure]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') finish();
      if (event.key === 'ArrowRight') next();
      if (event.key === 'ArrowLeft') setIndex((i) => Math.max(0, i - 1));
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  function next() {
    if (index < live.length - 1) setIndex(index + 1);
    else finish();
  }

  function finish() {
    if (storageKey) {
      try { localStorage.setItem(storageKey, 'done'); } catch { /* storage blocked */ }
    }
    onFinish?.();
    onClose();
  }

  if (!open || !step || typeof document === 'undefined') return null;

  // Place the bubble below the spotlight, or above when there is no room.
  const bubbleWidth = 340;
  let bubbleStyle = {
    position: 'fixed',
    width: bubbleWidth,
    left: Math.max(16, Math.min(
      (spot ? spot.left + spot.width / 2 - bubbleWidth / 2 : window.innerWidth / 2 - bubbleWidth / 2),
      window.innerWidth - bubbleWidth - 16,
    )),
    top: spot ? spot.top + spot.height + 14 : window.innerHeight / 2 - 100,
  };

  if (spot && bubbleStyle.top + 220 > window.innerHeight) {
    bubbleStyle = { ...bubbleStyle, top: Math.max(16, spot.top - 210) };
  }

  return createPortal(
    <div className="fixed inset-0 z-[80]">
      {/* A hole punched over the target, so the real UI stays visible. */}
      <div
        className="animate-fade absolute inset-0 transition-all duration-300"
        style={{
          background: 'rgb(11 16 23 / 0.62)',
          ...(spot
            ? {
                clipPath: `polygon(
                  0 0, 100% 0, 100% 100%, 0 100%, 0 0,
                  ${spot.left}px ${spot.top}px,
                  ${spot.left}px ${spot.top + spot.height}px,
                  ${spot.left + spot.width}px ${spot.top + spot.height}px,
                  ${spot.left + spot.width}px ${spot.top}px,
                  ${spot.left}px ${spot.top}px
                )`,
              }
            : {}),
        }}
        onClick={finish}
      />

      {spot && (
        <div
          className="pointer-events-none absolute rounded-[var(--radius-lg)] transition-all duration-300"
          style={{
            top: spot.top, left: spot.left, width: spot.width, height: spot.height,
            boxShadow: '0 0 0 2px var(--color-brand-400), 0 0 0 8px rgb(99 102 241 / 0.22)',
          }}
        />
      )}

      <div
        ref={bubbleRef}
        style={bubbleStyle}
        className="animate-pop rounded-[var(--radius-xl)] border border-[var(--border-subtle)] bg-[var(--surface-overlay)] p-4 shadow-[var(--shadow-xl)]"
        role="dialog"
        aria-label={step.title}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="flex size-6 items-center justify-center rounded-[var(--radius-sm)] bg-[var(--color-brand-600)] text-white">
              <Sparkles className="size-3.5" strokeWidth={2} />
            </span>
            <h3 className="text-base font-semibold">{step.title}</h3>
          </div>
          <button
            onClick={finish}
            aria-label="End tour"
            className="-mr-1 -mt-1 rounded p-1 text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)]"
          >
            <X className="size-3.5" />
          </button>
        </div>

        <p className="mt-2 text-sm leading-relaxed text-[var(--text-secondary)]">{step.body}</p>

        <div className="mt-4 flex items-center justify-between gap-3">
          <div className="flex gap-1" aria-hidden="true">
            {live.map((_, i) => (
              <span
                key={i}
                className={cn(
                  'h-1.5 rounded-full transition-all duration-300',
                  i === index ? 'w-4 bg-[var(--color-brand-500)]' : 'w-1.5 bg-[var(--surface-active)]',
                )}
              />
            ))}
          </div>

          <div className="flex items-center gap-1.5">
            {index > 0 && (
              <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={() => setIndex(index - 1)}>
                Back
              </Button>
            )}
            <Button variant="primary" size="sm" iconRight={index < live.length - 1 ? ArrowRight : undefined}
              onClick={next}>
              {index < live.length - 1 ? 'Next' : 'Got it'}
            </Button>
          </div>
        </div>

        <p className="mt-2.5 text-2xs text-[var(--text-disabled)]">
          {index + 1} of {live.length} · Esc to close
        </p>
      </div>
    </div>,
    document.body,
  );
}

/** Remembers whether someone has already seen a given tour. */
export function useTour(storageKey) {
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(true);

  useEffect(() => {
    try {
      setSeen(localStorage.getItem(storageKey) === 'done');
    } catch {
      setSeen(true); // storage blocked — never nag
    }
  }, [storageKey]);

  return {
    open,
    seen,
    start: () => setOpen(true),
    close: () => setOpen(false),
    reset: () => {
      try { localStorage.removeItem(storageKey); } catch { /* ignore */ }
      setSeen(false);
    },
    markSeen: () => setSeen(true),
  };
}
