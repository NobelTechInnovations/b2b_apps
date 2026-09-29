'use client';

import { useEffect, useMemo, useState } from 'react';
import { api } from './api';

/**
 * The people an app lets you pick from — Helpdesk agents, Recruitment
 * interviewers. Each app exposes its own list so nobody needs the workspace
 * member directory just to assign a ticket.
 */
export function usePeople(path, { enabled = true } = {}) {
  const [people, setPeople] = useState([]);

  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    api.get(path).then((r) => { if (live) setPeople(r.data ?? []); }).catch(() => {});
    return () => { live = false; };
  }, [path, enabled]);

  const byId = useMemo(() => new Map(people.map((p) => [p.user_id, p])), [people]);
  return { people, nameOf: (userId) => (userId ? byId.get(userId)?.name ?? 'A teammate' : null) };
}

/** "in 3h", "2d overdue" — how a deadline reads at a glance. */
export function dueIn(value) {
  if (!value) return null;
  const diff = new Date(value).getTime() - Date.now();
  const abs = Math.abs(diff);
  const text = abs < 3_600_000 ? `${Math.max(1, Math.round(abs / 60_000))}m`
    : abs < 172_800_000 ? `${Math.round(abs / 3_600_000)}h`
    : `${Math.round(abs / 86_400_000)}d`;
  return diff >= 0 ? `in ${text}` : `${text} overdue`;
}

/** Minutes as a person would say them: 90 → "1h 30m", 2880 → "2d". */
export function minutesLabel(minutes) {
  if (minutes === null || minutes === undefined) return '—';
  const m = Number(minutes);
  if (m < 60) return `${m}m`;
  if (m < 1440) return m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m / 60}h`;
  const days = Math.floor(m / 1440);
  const hours = Math.round((m % 1440) / 60);
  return hours ? `${days}d ${hours}h` : `${days}d`;
}

// Names that are brands, not words.
const PROPER = { whatsapp: 'WhatsApp', linkedin: 'LinkedIn' };

export const titleCase = (value) =>
  value ? PROPER[value] ?? value.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : '';
