'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, CheckCircle2, FileSpreadsheet, Link2, RotateCcw, Upload } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useWorkspace } from '@/lib/workspace';
import { Button } from '@/components/ui/button';
import { Checkbox, Input, Select } from '@/components/ui/input';
import { Table, THead, TBody, TH, TR, TD } from '@/components/ui/table';
import { Alert, Badge, Card, CardBody, CardHeader } from '@/components/ui/primitives';
import { Chip } from './lead-kit';

const MAX_BYTES = 10 * 1024 * 1024;
const TYPE_LABEL = { text: 'Text', long_text: 'Long text', number: 'Number', date: 'Date', select: 'Dropdown', multi_select: 'Multi-choice', checkbox: 'Yes / no', phone: 'Phone', email: 'Email', url: 'Link' };
const ROLE = {
  leads: { label: 'Leads', tone: 'positive' },
  followups: { label: 'Follow-ups', tone: 'info' },
  lists: { label: 'Dropdown lists', tone: 'neutral' },
  skipped: { label: 'Skipped', tone: 'neutral' },
};
const FOLLOW_ROLES = [
  ['link', 'Linked to lead by'], ['date', 'Date'], ['mode', 'Call / WhatsApp / email'], ['by', 'Done by'], ['summary', 'Summary'],
  ['outcome', 'Result'], ['remarks', 'Remarks'], ['next_date', 'Next follow-up'], ['next_action', 'Next action'], ['status', 'Open / closed'], ['priority', 'Priority'],
];

/**
 * A whole Excel workbook or Google Sheet: every tab is read, the leads tab's
 * columns become fields (made automatically when missing, dropdowns with the
 * sheet's own options), and the follow-ups tab is attached to its leads.
 */
export function WorkbookImport({ modeSwitch, team = [] }) {
  const { user } = useWorkspace();
  const input = useRef(null);
  const [source, setSource] = useState(null);
  const [sheetUrl, setSheetUrl] = useState('');
  const [plan, setPlan] = useState(null);
  const [choices, setChoices] = useState({});
  const [owner, setOwner] = useState('');
  const [withFollowups, setWithFollowups] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const [result, setResult] = useState(null);
  const [dragging, setDragging] = useState(false);

  async function preview(body) {
    setBusy(true);
    setProblem(null);
    setPlan(null);
    try {
      const data = (await api.post('/leads/import/workbook/preview', body)).data;
      setSource(body);
      setPlan(data);
      setChoices(Object.fromEntries(data.leads.columns.map((c) => [c.header, { action: c.action, target: c.target, type: c.type, label: c.label }])));
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : 'Could not read that file.');
    } finally {
      setBusy(false);
    }
  }

  function readFile(file) {
    if (!file) return;
    if (!/\.xlsx$/i.test(file.name)) { setProblem('Choose an Excel file (.xlsx). For a .csv file use the CSV option.'); return; }
    if (file.size > MAX_BYTES) { setProblem('That file is larger than 10 MB. Split it into smaller files.'); return; }
    const reader = new FileReader();
    reader.onload = () => preview({ file_base64: String(reader.result), file_name: file.name });
    reader.readAsDataURL(file);
  }

  async function run() {
    setBusy(true);
    setProblem(null);
    try {
      const columns = Object.entries(choices).map(([header, c]) => ({
        header, action: c.action,
        ...(c.action === 'map' ? { target: c.target } : {}),
        ...(c.action === 'create' ? { type: c.type, label: c.label } : {}),
      }));
      const data = (await api.post('/leads/import/workbook', {
        ...source, name: plan.name, columns, skip_followups: !withFollowups,
        ...(owner === 'me' ? { owner_user_id: user.id } : owner ? { owner_user_id: owner } : {}),
      })).data;
      setResult(data);
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : 'The import did not finish.');
    } finally {
      setBusy(false);
    }
  }

  const reset = () => { setPlan(null); setResult(null); setSource(null); setProblem(null); if (input.current) input.current.value = ''; };
  const set = (header, patch) => setChoices((all) => ({ ...all, [header]: { ...all[header], ...patch } }));

  if (result) {
    return (
      <Card>
        <CardBody className="space-y-4">
          <p className="flex items-center gap-2 text-lg font-semibold"><CheckCircle2 className="size-5 text-[var(--color-positive-600)]" />Workbook imported</p>
          <ul className="space-y-1 text-sm">
            <li><strong>{result.created}</strong> new leads{result.duplicates ? `, ${result.duplicates} already here (skipped)` : ''}{result.failed ? `, ${result.failed} rows without a name, phone or email` : ''}.</li>
            {result.fields_created.length > 0 && <li><strong>{result.fields_created.length}</strong> fields created: {result.fields_created.map((f) => f.label).join(', ')}.</li>}
            {result.stages_created.length > 0 && <li><strong>{result.stages_created.length}</strong> stages added: {result.stages_created.join(', ')}.</li>}
            {(result.followups.imported > 0 || result.followups.scheduled > 0) && (
              <li><strong>{result.followups.imported}</strong> past follow-ups added to their leads{result.followups.scheduled ? `, ${result.followups.scheduled} upcoming follow-ups scheduled` : ''}.</li>
            )}
            {result.followups.unmatched > 0 && <li className="text-[var(--color-caution-700)]">{result.followups.unmatched} follow-ups name an ID that is not in the leads tab, so they were left out.</li>}
            {result.followups.duplicates > 0 && <li className="text-[var(--text-secondary)]">{result.followups.duplicates} follow-ups were already imported before.</li>}
          </ul>
          {result.errors?.length > 0 && <Alert tone="caution">{result.errors.slice(0, 5).map((e) => `Row ${e.row}: ${e.message}`).join(' · ')}</Alert>}
          <div className="flex flex-wrap gap-2">
            <Link href="/leads"><Button variant="primary" iconRight={ArrowRight}>Open leads</Button></Link>
            <Link href="/leads/reports"><Button variant="secondary">See reports</Button></Link>
            <Button variant="ghost" icon={RotateCcw} onClick={reset}>Import another</Button>
          </div>
          <p className="text-xs text-[var(--text-tertiary)]">Importing the same workbook again later adds only new students and new follow-ups.</p>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardBody className="space-y-5">
        {modeSwitch}
        {!plan && (
          <div className="grid gap-4 md:grid-cols-2">
            <label
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => { e.preventDefault(); setDragging(false); readFile(e.dataTransfer.files?.[0]); }}
              className={cn('flex cursor-pointer flex-col items-center justify-center gap-2 rounded-[var(--radius-xl)] border-2 border-dashed px-6 py-8 text-center transition-colors',
                dragging ? 'border-[var(--color-brand-500)] bg-[var(--color-brand-50)]' : 'border-[var(--border-default)] hover:bg-[var(--surface-hover)]')}
            >
              <Upload className="size-6 text-[var(--text-tertiary)]" />
              <span className="font-medium">Drop an Excel file (.xlsx), or click to choose</span>
              <span className="text-xs text-[var(--text-tertiary)]">Every tab is read. Up to 10 MB.</span>
              <input ref={input} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="sr-only" onChange={(e) => readFile(e.target.files?.[0])} />
            </label>
            <div className="space-y-2 rounded-[var(--radius-xl)] border border-[var(--border-default)] p-5">
              <p className="flex items-center gap-2 font-medium"><Link2 className="size-4" />Or a Google Sheet</p>
              <Input value={sheetUrl} onChange={(e) => setSheetUrl(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…" />
              <Button variant="primary" loading={busy} disabled={!sheetUrl.trim()} onClick={() => preview({ sheet_url: sheetUrl.trim() })}>Read all tabs</Button>
              <p className="text-xs text-[var(--text-tertiary)]">Share → General access → <strong>Anyone with the link (Viewer)</strong>.</p>
            </div>
          </div>
        )}
        {busy && !plan && <p className="text-sm text-[var(--text-secondary)]">Reading every tab…</p>}
        {problem && <Alert tone="critical">{problem}</Alert>}

        {plan && (
          <div className="space-y-6">
            <div>
              <h3 className="mb-2 flex items-center gap-2 font-medium"><FileSpreadsheet className="size-4" />{plan.name}: what each tab is</h3>
              <div className="flex flex-wrap gap-2">
                {plan.tabs.map((t) => (
                  <span key={t.name} className="flex items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--border-subtle)] px-2.5 py-1.5 text-sm">
                    <strong>{t.name}</strong><Badge size="sm" tone={ROLE[t.role].tone}>{ROLE[t.role].label}</Badge>
                    {['leads', 'followups'].includes(t.role) && <span className="text-xs text-[var(--text-tertiary)]">{t.rows.toLocaleString('en-IN')} rows</span>}
                  </span>
                ))}
              </div>
            </div>

            <div>
              <h3 className="mb-1 font-medium">Columns of “{plan.leads.tab}”</h3>
              <p className="mb-3 text-sm text-[var(--text-secondary)]">
                Columns that match a lead field go there; the rest become new fields{plan.leads.key ? <>, and <strong>{plan.leads.key}</strong> links the follow-ups</> : null}.
                Columns the sheet calculates itself (auto) are skipped — Nexus counts calls and follow-ups from the history.
              </p>
              {!plan.can_create_fields && plan.leads.columns.some((c) => c.action === 'create') && (
                <Alert tone="caution" className="mb-3">Creating new fields needs the “Lead sources, fields and stages” ability. Ask an owner, or set those columns to Skip.</Alert>
              )}
              <div className="overflow-x-auto">
                <Table>
                  <THead><tr><TH>Column in the sheet</TH><TH>Example</TH><TH>Goes into</TH><TH>Type</TH></tr></THead>
                  <TBody>
                    {plan.leads.columns.map((c) => {
                      const choice = choices[c.header] ?? {};
                      const value = choice.action === 'skip' ? 'skip' : choice.action === 'create' ? 'create' : choice.target;
                      return (
                        <TR key={c.header}>
                          <TD className="font-medium">
                            {c.header}
                            {c.key && <Badge size="sm" tone="info" className="ml-1.5">Links follow-ups</Badge>}
                          </TD>
                          <TD className="max-w-[14rem] truncate text-sm text-[var(--text-secondary)]">
                            {plan.sample.map((r) => r[c.header]).filter(Boolean).slice(0, 2).join(' · ') || (c.options?.length ? c.options.slice(0, 3).join(', ') + (c.options.length > 3 ? '…' : '') : '—')}
                          </TD>
                          <TD>
                            <Select
                              value={value ?? 'skip'}
                              aria-label={`Field for ${c.header}`}
                              className={cn('w-56', value && value !== 'skip' && 'border-[var(--color-brand-400)]')}
                              onChange={(e) => {
                                const next = e.target.value;
                                if (next === 'skip') set(c.header, { action: 'skip' });
                                else if (next === 'create') set(c.header, { action: 'create', type: choice.type ?? c.type ?? 'text', label: choice.label ?? c.label ?? c.header });
                                else set(c.header, { action: 'map', target: next });
                              }}
                            >
                              <option value="create">＋ New field “{c.label ?? c.header}”</option>
                              <optgroup label="Lead fields">
                                {plan.targets.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                              </optgroup>
                              <option value="skip">Skip this column</option>
                            </Select>
                          </TD>
                          <TD>
                            {choice.action === 'create' ? (
                              <Select value={choice.type ?? 'text'} onChange={(e) => set(c.header, { type: e.target.value })} className="w-36" aria-label={`Type of ${c.header}`}>
                                {Object.entries(TYPE_LABEL).filter(([t]) => (t === 'select' || t === 'multi_select' ? c.options?.length : true)).map(([t, label]) => (
                                  <option key={t} value={t}>{label}{t === 'select' && c.options?.length ? ` (${c.options.length})` : ''}</option>
                                ))}
                              </Select>
                            ) : choice.action === 'skip' ? <span className="text-xs text-[var(--text-tertiary)]">{c.reason ?? ''}</span>
                              : choice.target === 'stage' && c.new_stages?.length ? <span className="text-xs text-[var(--text-secondary)]">Adds stages: {c.new_stages.map((s) => s.name).join(', ')}</span>
                                : null}
                          </TD>
                        </TR>
                      );
                    })}
                  </TBody>
                </Table>
              </div>
            </div>

            {plan.followups && (
              <Card>
                <CardHeader
                  title={`Follow-ups from “${plan.followups.tab}”`}
                  description={`${plan.followups.rows.toLocaleString('en-IN')} rows, each added to its lead's history; a next date still ahead becomes a scheduled follow-up.`}
                  action={<Checkbox checked={withFollowups} onChange={(e) => setWithFollowups(e.target.checked)} label="Import them" />}
                />
                <CardBody className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
                  {FOLLOW_ROLES.filter(([key]) => plan.followups.roles[key]).map(([key, label]) => (
                    <span key={key}><span className="text-[var(--text-tertiary)]">{label}:</span> {plan.followups.roles[key]}</span>
                  ))}
                </CardBody>
              </Card>
            )}

            <div className="flex flex-wrap items-end gap-3">
              <label className="space-y-1 text-sm">
                <span className="font-medium">Owner when the sheet has none</span>
                <Select value={owner} onChange={(e) => setOwner(e.target.value)} className="w-56">
                  <option value="">Unassigned</option>
                  <option value="me">Me</option>
                  {team.filter((m) => m.user_id !== user?.id).map((m) => <option key={m.user_id} value={m.user_id}>{m.name ?? m.email}</option>)}
                </Select>
              </label>
              <div className="flex-1" />
              <Button variant="ghost" onClick={reset}>Choose another file</Button>
              <Button variant="primary" loading={busy} onClick={run} iconRight={ArrowRight}>
                Import {plan.leads.rows.toLocaleString('en-IN')} leads{plan.followups && withFollowups ? ` and ${plan.followups.rows.toLocaleString('en-IN')} follow-ups` : ''}
              </Button>
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

/** The chip that switches the import page to workbooks. */
export const WorkbookChip = ({ active, onClick }) => (
  <Chip active={active} onClick={onClick}><FileSpreadsheet className="mr-1 inline size-3.5" />Excel workbook (all tabs)</Chip>
);
