'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { tintFor } from '@/lib/app-theme';
import { Input, Select, Textarea, Checkbox } from '@/components/ui/input';

/* ── workspace setup: stages, fields, team ─────────────────────────────────── */
let cached = null;

/** Stages, custom fields, the team and outcomes. Fetched once per page load. */
export function useLeadsMeta() {
  const [meta, setMeta] = useState(cached);
  const reload = useCallback(async () => {
    const response = await api.get('/leads/meta');
    cached = response.data;
    setMeta(response.data);
    return response.data;
  }, []);
  useEffect(() => {
    if (!cached) reload().catch(() => {});
  }, [reload]);
  return { meta, reload };
}
export const forgetLeadsMeta = () => { cached = null; };

export const TZ = typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'Asia/Kolkata';

/* ── stages ───────────────────────────────────────────────────────────────── */
export function StageBadge({ stage, name, color, className }) {
  const label = stage?.name ?? name;
  if (!label) return <span className="text-[var(--text-disabled)]">—</span>;
  return (
    <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', tintFor(stage?.color ?? color), className)}>
      {label}
    </span>
  );
}

export const STAGE_COLORS = ['slate', 'blue', 'sky', 'cyan', 'teal', 'emerald', 'lime', 'amber', 'orange', 'rose', 'pink', 'violet', 'indigo'];

/* ── calls ───────────────────────────────────────────────────────────────── */
export const OUTCOME_TONE = {
  interested: 'positive', connected: 'info', call_back: 'caution', not_interested: 'neutral',
  no_answer: 'critical', busy: 'critical', switched_off: 'critical', wrong_number: 'neutral',
};
export const OUTCOME_LABEL = {
  interested: 'Interested', call_back: 'Call back', not_interested: 'Not interested', no_answer: 'No answer',
  busy: 'Busy', switched_off: 'Unreachable', wrong_number: 'Wrong number', connected: 'Spoke to them',
};

export const SOURCE_LABEL = {
  manual: 'Added by hand', website: 'Website', referral: 'Referral', campaign: 'Campaign', event: 'Event',
  cold_call: 'Cold call', import: 'Import', api: 'API', partner: 'Partner', meta: 'Meta ads',
  google_sheet: 'Google Sheet', survey: 'Survey form', webhook: 'Webhook', whatsapp: 'WhatsApp', walk_in: 'Walk-in',
};

/** wa.me wants the full international number; a bare 10-digit number is Indian. */
export function whatsappLink(phone, text) {
  let digits = String(phone ?? '').replace(/[^0-9]/g, '');
  if (!digits) return null;
  if (digits.length === 10) digits = `91${digits}`;
  if (digits.length === 11 && digits.startsWith('0')) digits = `91${digits.slice(1)}`;
  return `https://wa.me/${digits}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}
export const telLink = (phone) => (phone ? `tel:${String(phone).replace(/[^0-9+]/g, '')}` : null);

/* ── follow-up times ─────────────────────────────────────────────────────── */
const at = (days, hour, minute = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, minute, 0, 0);
  return d;
};

/** The choices a caller actually reaches for, computed from now. */
export function followupPresets() {
  const now = new Date();
  const inHour = new Date(now.getTime() + 60 * 60_000);
  inHour.setSeconds(0, 0);
  const presets = [{ key: '1h', label: 'In 1 hour', at: inHour }];
  if (now.getHours() < 17) presets.push({ key: 'evening', label: 'This evening', at: at(0, 18) });
  presets.push(
    { key: 'tomorrow', label: 'Tomorrow 10 am', at: at(1, 10) },
    { key: '3d', label: 'In 3 days', at: at(3, 10) },
    { key: 'week', label: 'Next week', at: at(7, 10) },
  );
  return presets;
}

/** `Date` ↔ the value of an `<input type="datetime-local">`. */
export const toLocalInput = (value) => {
  if (!value) return '';
  const d = new Date(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export const fromLocalInput = (value) => (value ? new Date(value).toISOString() : null);

/** "Today, 3:30 pm" · "Tomorrow, 10:00 am" · "Mon 12 Oct, 4:00 pm" — and whether it is late. */
export function dueLabel(value) {
  if (!value) return { text: '—', overdue: false, today: false };
  const d = new Date(value);
  const now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(now)) / 86_400_000);
  const time = d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  const date = diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : diff === -1 ? 'Yesterday'
    : d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
  return { text: `${date}, ${time}`, overdue: d < now, today: diff === 0 };
}

export function FollowupPicker({ value, onChange, allowNone = true }) {
  const presets = followupPresets();
  const [custom, setCustom] = useState(false);
  const chosen = presets.find((p) => value && Math.abs(new Date(value) - p.at) < 60_000);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {allowNone && (
          <Chip active={!value && !custom} onClick={() => { setCustom(false); onChange(null); }}>No follow-up</Chip>
        )}
        {presets.map((p) => (
          <Chip key={p.key} active={chosen?.key === p.key && !custom} onClick={() => { setCustom(false); onChange(p.at.toISOString()); }}>
            {p.label}
          </Chip>
        ))}
        <Chip active={custom || (value && !chosen)} onClick={() => setCustom(true)}>Pick date & time</Chip>
      </div>
      {(custom || (value && !chosen)) && (
        <Input
          type="datetime-local"
          value={toLocalInput(value)}
          min={toLocalInput(new Date())}
          onChange={(e) => onChange(fromLocalInput(e.target.value))}
          className="max-w-xs"
        />
      )}
    </div>
  );
}

export function Chip({ active, onClick, children, tone, className }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
        active
          ? 'border-[var(--color-brand-500)] bg-[var(--color-brand-50)] text-[var(--color-brand-700)] dark:bg-[rgb(99_102_241/0.14)] dark:text-[var(--color-brand-300)]'
          : 'border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
        tone === 'critical' && !active && 'text-[var(--color-critical-600)]',
        className,
      )}
    >
      {children}
    </button>
  );
}

/* ── the workspace's own fields ──────────────────────────────────────────── */
export const FIELD_TYPE_LABEL = {
  text: 'Short text', long_text: 'Paragraph', number: 'Number', date: 'Date', select: 'Dropdown (one)',
  multi_select: 'Multiple choice', checkbox: 'Yes / No', phone: 'Phone', email: 'Email', url: 'Web link',
};

export function CustomFieldInput({ field, value, onChange, id, ...rest }) {
  const common = { id, 'aria-describedby': rest['aria-describedby'] };
  switch (field.type) {
    case 'long_text':
      return <Textarea {...common} rows={3} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
    case 'number':
      return <Input {...common} type="number" step="any" value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)} />;
    case 'date':
      return <Input {...common} type="date" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} />;
    case 'select':
      return (
        <Select {...common} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">Choose…</option>
          {field.options.map((o) => <option key={o} value={o}>{o}</option>)}
        </Select>
      );
    case 'multi_select': {
      const list = Array.isArray(value) ? value : [];
      return (
        <div className="flex flex-wrap gap-1.5" {...common}>
          {field.options.map((o) => (
            <Chip key={o} active={list.includes(o)} onClick={() => onChange(list.includes(o) ? list.filter((x) => x !== o) : [...list, o])}>{o}</Chip>
          ))}
        </div>
      );
    }
    case 'checkbox':
      return <Checkbox {...common} checked={value === true} onChange={(e) => onChange(e.target.checked)} label={field.label} />;
    default:
      return (
        <Input
          {...common}
          type={field.type === 'email' ? 'email' : field.type === 'url' ? 'url' : field.type === 'phone' ? 'tel' : 'text'}
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

/** A custom value, readably: lists joined, booleans as Yes/No, numbers grouped. */
export function customValue(field, value) {
  if (value === undefined || value === null || value === '') return null;
  if (Array.isArray(value)) return value.join(', ');
  if (field?.type === 'checkbox') return value ? 'Yes' : 'No';
  if (field?.type === 'number' && Number.isFinite(Number(value))) return Number(value).toLocaleString('en-IN');
  if (field?.type === 'date') return new Date(value).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  return String(value);
}
