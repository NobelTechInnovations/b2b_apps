'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Upload, FileSpreadsheet, Sheet, Download, ArrowRight, CheckCircle2, RotateCcw, History } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { relativeTime } from '@/lib/format';
import { useWorkspace } from '@/lib/workspace';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Field, Select, Checkbox } from '@/components/ui/input';
import { Table, THead, TBody, TH, TR, TD } from '@/components/ui/table';
import { Card, CardHeader, CardBody, PageHeader, Alert, Badge } from '@/components/ui/primitives';
import { Chip, useLeadsMeta } from '@/components/leads/lead-kit';

const MAX_BYTES = 4 * 1024 * 1024;

export default function ImportClient() {
  const toast = useToast();
  const { user } = useWorkspace();
  const { meta } = useLeadsMeta();
  const fileRef = useRef(null);
  const [mode, setMode] = useState('csv');
  const [csv, setCsv] = useState(null);
  const [fileName, setFileName] = useState('');
  const [sheetUrl, setSheetUrl] = useState('');
  const [preview, setPreview] = useState(null);
  const [mapping, setMapping] = useState({});
  const [assign, setAssign] = useState('me');
  const [ownerId, setOwnerId] = useState('');
  const [pool, setPool] = useState([]);
  const [stageId, setStageId] = useState('');
  const [tags, setTags] = useState('');
  const [name, setName] = useState('');
  const [keepSynced, setKeepSynced] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const [result, setResult] = useState(null);
  const [history, setHistory] = useState([]);
  const [dragging, setDragging] = useState(false);

  const loadHistory = () => api.get('/leads/imports').then((r) => setHistory(r.data)).catch(() => {});
  useEffect(() => { loadHistory(); }, []);

  async function readFile(file) {
    setProblem(null);
    if (!file) return;
    if (/\.xlsx?$/i.test(file.name)) { setProblem('That is an Excel file. In Excel choose File → Save As → CSV (Comma delimited), then upload the .csv.'); return; }
    if (file.size > MAX_BYTES) { setProblem('That file is larger than 4 MB. Split it into smaller files.'); return; }
    const text = await file.text();
    setCsv(text);
    setFileName(file.name);
    setName(file.name.replace(/\.[^.]+$/, ''));
    await runPreview({ csv: text });
  }

  async function runPreview(body) {
    setBusy(true);
    setProblem(null);
    setResult(null);
    try {
      const response = await api.post('/leads/import/preview', body);
      setPreview(response.data);
      setMapping(Object.fromEntries(response.data.headers.map((h) => [h, response.data.mapping[h] ?? 'skip'])));
    } catch (err) {
      setPreview(null);
      setProblem(err instanceof ApiError ? err.message : 'Could not read that.');
    } finally {
      setBusy(false);
    }
  }

  async function run() {
    setBusy(true);
    setProblem(null);
    try {
      const body = {
        ...(mode === 'csv' ? { csv } : { sheet_url: sheetUrl.trim(), keep_synced: keepSynced }),
        name: name.trim() || undefined,
        mapping,
        stage_id: stageId || null,
        tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
      };
      if (assign === 'me') body.owner_user_id = user?.id;
      if (assign === 'one') body.owner_user_id = ownerId || null;
      if (assign === 'round') body.assign_to = pool;
      const response = await api.post('/leads/import', body);
      setResult(response.data);
      toast.success(`${response.data.created} leads imported`);
      loadHistory();
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : 'The import failed.');
    } finally {
      setBusy(false);
    }
  }

  function template() {
    const headers = ['Name', 'Phone', 'Email', 'Company', 'City', 'Notes', ...(meta?.fields ?? []).map((f) => f.label)];
    const blob = new Blob([`${headers.join(',')}\nRavi Kumar,98765 43210,ravi@example.com,Kumar Traders,Pune,Wants a callback after 6 pm\n`], { type: 'text/csv' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'leads-template.csv';
    link.click();
    URL.revokeObjectURL(link.href);
  }

  const reset = () => { setPreview(null); setCsv(null); setFileName(''); setResult(null); setProblem(null); if (fileRef.current) fileRef.current.value = ''; };
  const targets = preview?.targets ?? [];
  const hasContact = Object.values(mapping).some((t) => ['full_name', 'first_name', 'phone', 'email'].includes(t));
  const roundReady = assign !== 'round' || pool.length > 0;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Import leads"
        description="From a CSV file or a Google Sheet. Duplicates (same phone or email) are skipped."
        actions={<Button variant="ghost" icon={Download} onClick={template}>Download template</Button>}
      />

      {result ? (
        <Card>
          <CardBody className="space-y-4">
            <div className="flex items-center gap-3">
              <CheckCircle2 className="size-8 text-[var(--color-positive-500)]" />
              <div>
                <p className="text-lg font-semibold">{result.created} new lead{result.created === 1 ? '' : 's'} added</p>
                <p className="text-sm text-[var(--text-secondary)]">
                  {result.duplicates} duplicate{result.duplicates === 1 ? '' : 's'} skipped · {result.failed} row{result.failed === 1 ? '' : 's'} could not be used
                  {result.source_id ? ' · this sheet stays connected and new rows arrive every 15 minutes' : ''}
                </p>
              </div>
            </div>
            {result.errors?.length > 0 && (
              <Alert tone="caution" title="Rows that were skipped">
                <ul className="mt-1 space-y-0.5 text-sm">
                  {result.errors.slice(0, 10).map((e) => <li key={e.row}>Row {e.row}: {e.message}</li>)}
                </ul>
              </Alert>
            )}
            <div className="flex gap-2">
              <Link href="/leads?view=fresh"><Button variant="primary" iconRight={ArrowRight}>Start calling</Button></Link>
              <Button variant="secondary" icon={RotateCcw} onClick={reset}>Import another</Button>
            </div>
          </CardBody>
        </Card>
      ) : (
        <Card>
          <CardBody className="space-y-5">
            <div className="flex gap-1.5">
              <Chip active={mode === 'csv'} onClick={() => { setMode('csv'); reset(); }}><FileSpreadsheet className="mr-1 inline size-3.5" />CSV file</Chip>
              <Chip active={mode === 'sheet'} onClick={() => { setMode('sheet'); reset(); }}><Sheet className="mr-1 inline size-3.5" />Google Sheet</Chip>
            </div>

            {mode === 'csv' ? (
              <label
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => { e.preventDefault(); setDragging(false); readFile(e.dataTransfer.files?.[0]); }}
                className={cn('flex cursor-pointer flex-col items-center justify-center gap-2 rounded-[var(--radius-xl)] border-2 border-dashed px-6 py-10 text-center transition-colors',
                  dragging ? 'border-[var(--color-brand-500)] bg-[var(--color-brand-50)]' : 'border-[var(--border-default)] hover:bg-[var(--surface-hover)]')}
              >
                <Upload className="size-6 text-[var(--text-tertiary)]" />
                <span className="font-medium">{fileName || 'Drop a CSV here, or click to choose'}</span>
                <span className="text-xs text-[var(--text-tertiary)]">Excel: File → Save As → CSV. Up to 20,000 rows, 4 MB.</span>
                <input ref={fileRef} type="file" accept=".csv,text/csv,.xlsx,.xls" className="sr-only" onChange={(e) => readFile(e.target.files?.[0])} />
              </label>
            ) : (
              <div className="space-y-2">
                <div className="flex gap-2">
                  <Input value={sheetUrl} onChange={(e) => setSheetUrl(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…" className="flex-1" icon={Sheet} />
                  <Button variant="primary" loading={busy && !preview} disabled={!sheetUrl.trim()} onClick={() => { setName('Google Sheet'); runPreview({ sheet_url: sheetUrl.trim() }); }}>Read sheet</Button>
                </div>
                <p className="text-xs text-[var(--text-tertiary)]">
                  In Google Sheets choose <strong>Share → General access → Anyone with the link (Viewer)</strong>, then copy the link of the tab with your leads.
                </p>
              </div>
            )}

            {problem && <Alert tone="critical">{problem}</Alert>}

            {preview && (
              <div className="space-y-5">
                <div>
                  <h3 className="mb-1 font-medium">Match the columns</h3>
                  <p className="mb-3 text-sm text-[var(--text-secondary)]">
                    {preview.total.toLocaleString('en-IN')} rows found{preview.truncated ? ` (only the first ${preview.max_rows.toLocaleString('en-IN')} will be imported)` : ''}.
                    Columns you skip are kept in each lead’s notes.
                  </p>
                  <Table>
                    <THead><tr><TH>Column in your file</TH><TH>Example</TH><TH>Goes into</TH></tr></THead>
                    <TBody>
                      {preview.headers.map((h) => (
                        <TR key={h}>
                          <TD className="font-medium">{h}</TD>
                          <TD className="max-w-[16rem] truncate text-sm text-[var(--text-secondary)]">{preview.sample.map((r) => r[h]).filter(Boolean).slice(0, 2).join(' · ') || '—'}</TD>
                          <TD>
                            <Select value={mapping[h] ?? 'skip'} onChange={(e) => setMapping((m) => ({ ...m, [h]: e.target.value }))} aria-label={`Field for ${h}`}
                              className={cn('w-56', mapping[h] && mapping[h] !== 'skip' && 'border-[var(--color-brand-400)]')}>
                              <option value="skip">Don’t import (keep in notes)</option>
                              {targets.map((t) => (
                                <option key={t.key} value={t.key} disabled={Object.entries(mapping).some(([k, v]) => v === t.key && k !== h)}>{t.label}</option>
                              ))}
                            </Select>
                          </TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                  {!hasContact && <Alert tone="caution" className="mt-3">Match at least one column to Name, Phone or Email.</Alert>}
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Give the leads to">
                    {(p) => (
                      <Select {...p} value={assign} onChange={(e) => setAssign(e.target.value)}>
                        <option value="me">Me</option>
                        <option value="one">One person</option>
                        <option value="round">Share between people (round-robin)</option>
                        <option value="none">Nobody yet (assign later)</option>
                      </Select>
                    )}
                  </Field>
                  {assign === 'one' && (
                    <Field label="Person">
                      {(p) => (
                        <Select {...p} value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
                          <option value="">Choose…</option>
                          {(meta?.team ?? []).map((m) => <option key={m.user_id} value={m.user_id}>{m.name ?? m.email}</option>)}
                        </Select>
                      )}
                    </Field>
                  )}
                  <Field label="Stage">
                    {(p) => (
                      <Select {...p} value={stageId} onChange={(e) => setStageId(e.target.value)}>
                        <option value="">First stage ({meta?.stages?.find((s) => s.kind === 'open')?.name ?? 'New'})</option>
                        {(meta?.stages ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </Select>
                    )}
                  </Field>
                  <Field label="Tags" hint="Added to every imported lead.">
                    {(p) => <Input {...p} value={tags} onChange={(e) => setTags(e.target.value)} placeholder="expo-2026" />}
                  </Field>
                  <Field label="Name this import" hint="Shown as the lead's source.">
                    {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} />}
                  </Field>
                </div>
                {assign === 'round' && (
                  <div>
                    <p className="mb-2 text-sm font-medium">Share between</p>
                    <div className="flex flex-wrap gap-1.5">
                      {(meta?.team ?? []).map((m) => (
                        <Chip key={m.user_id} active={pool.includes(m.user_id)} onClick={() => setPool((list) => (list.includes(m.user_id) ? list.filter((x) => x !== m.user_id) : [...list, m.user_id]))}>
                          {m.name ?? m.email}
                        </Chip>
                      ))}
                    </div>
                  </div>
                )}
                {mode === 'sheet' && (
                  <Checkbox checked={keepSynced} onChange={(e) => setKeepSynced(e.target.checked)} label="Keep this sheet connected" description="New rows added to the sheet arrive as leads every 15 minutes. Manage it under Lead sources." />
                )}
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={reset}>Start over</Button>
                  <Button variant="primary" icon={Upload} loading={busy} disabled={!hasContact || !roundReady || (assign === 'one' && !ownerId)} onClick={run}>
                    Import {preview.total.toLocaleString('en-IN')} rows
                  </Button>
                </div>
              </div>
            )}
          </CardBody>
        </Card>
      )}

      {history.length > 0 && (
        <Card>
          <CardHeader title={<span className="flex items-center gap-2"><History className="size-4" /> Recent imports and syncs</span>} />
          <Table>
            <THead><tr><TH>Name</TH><TH>From</TH><TH align="right">Added</TH><TH align="right">Duplicates</TH><TH align="right">Skipped</TH><TH>By</TH><TH>When</TH></tr></THead>
            <TBody>
              {history.map((h) => (
                <TR key={h.id}>
                  <TD className="font-medium">{h.name ?? '—'}</TD>
                  <TD><Badge size="sm">{{ csv: 'CSV', google_sheet: 'Google Sheet', meta: 'Meta', webhook: 'Webhook' }[h.kind]}</Badge></TD>
                  <TD align="right" numeric>{h.created}</TD>
                  <TD align="right" numeric>{h.duplicates}</TD>
                  <TD align="right" numeric>{h.failed}</TD>
                  <TD className="text-sm text-[var(--text-secondary)]">{h.by?.name ?? 'Automatic sync'}</TD>
                  <TD className="text-sm text-[var(--text-secondary)]">{relativeTime(h.created_at)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
