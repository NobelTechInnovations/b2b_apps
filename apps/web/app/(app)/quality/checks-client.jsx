'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ClipboardCheck, Plus, Check, X } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { relativeTime } from '@/lib/format';
import { Can, useWorkspace } from '@/lib/workspace';
import { titleCase } from '@/lib/people';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Field, Select, Textarea, Checkbox } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Drawer, DetailGrid } from '@/components/data/drawer';
import { StatTile } from '@/components/data/stat-tile';
import { useOptions } from '@/components/data/resource-page';
import { ProductPicker } from '@/components/data/line-items';
import { Table, THead, TBody, TH, TR, TD, TableSkeleton } from '@/components/ui/table';
import { Badge, Card, EmptyState, PageHeader, Alert } from '@/components/ui/primitives';

const TONE = { pending: 'caution', passed: 'positive', failed: 'critical' };

export default function ChecksClient() {
  const router = useRouter();
  const params = useSearchParams();
  const [status, setStatus] = useState('pending');
  const [rows, setRows] = useState(null);
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => { if (params.get('check')) setOpenId(params.get('check')); }, [params]);

  const load = useCallback(() => {
    api.get('/quality/checks', { query: { status: status || undefined } }).then((r) => setRows(r.data)).catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load checks.'));
    api.get('/quality/overview').then((r) => setStats(r.data)).catch(() => {});
  }, [status]);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Quality checks"
        description="Raised automatically when goods are received or a batch is finished, following your inspection plans. Record each checkpoint; a failure opens a non-conformance report."
        actions={<Can permission="quality.checks.perform"><Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>Manual check</Button></Can>}
      />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Waiting to be checked" value={stats?.pending} loading={!stats} tone={stats?.pending ? 'caution' : 'neutral'} />
        <StatTile label="Pass rate (30 days)" value={stats?.pass_rate ?? '—'} format={stats?.pass_rate === null ? 'raw' : 'percent'} loading={!stats} tone="positive" />
        <StatTile label="Failed (30 days)" value={stats?.failed_30d} loading={!stats} tone={stats?.failed_30d ? 'critical' : 'neutral'} />
        <StatTile label="Open reports" value={stats?.open_ncrs} loading={!stats} hint={<Link href="/quality/ncr" className="text-[var(--color-brand-600)]">View</Link>} />
      </div>
      <div className="flex gap-1">
        {[['pending', 'To check'], ['failed', 'Failed'], ['passed', 'Passed'], ['', 'All']].map(([key, label]) => <Button key={key} size="sm" variant={status === key ? 'primary' : 'ghost'} onClick={() => setStatus(key)}>{label}</Button>)}
      </div>
      {error && <Alert tone="critical">{error}</Alert>}
      {!rows ? <TableSkeleton rows={5} columns={5} /> : rows.length === 0 ? (
        <Card><EmptyState icon={ClipboardCheck} title={status === 'pending' ? 'Nothing waiting' : 'No checks'} description="Create an inspection plan, and checks will be raised on receipt or production." action={<Link href="/quality/plans"><Button variant="secondary">Inspection plans</Button></Link>} /></Card>
      ) : (
        <Table>
          <THead><tr><TH>Check</TH><TH>Product</TH><TH>From</TH><TH>Status</TH><TH>Raised</TH></tr></THead>
          <TBody>
            {rows.map((r) => (
              <TR key={r.id} onClick={() => setOpenId(r.id)}>
                <TD className="font-medium">{r.number}<p className="text-xs font-normal text-[var(--text-tertiary)]">{r.plan_name ?? 'Manual'}</p></TD>
                <TD>{r.product_name ?? '—'}{r.quantity && <span className="text-[var(--text-tertiary)]"> × {Number(r.quantity)}</span>}</TD>
                <TD className="text-[var(--text-secondary)]">{titleCase(r.trigger)}{r.source_ref ? ` · ${r.source_ref}` : ''}</TD>
                <TD><Badge size="sm" tone={TONE[r.status]}>{titleCase(r.status)}</Badge></TD>
                <TD className="text-[var(--text-secondary)]">{relativeTime(r.created_at)}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
      {creating && <ManualCheck onClose={() => setCreating(false)} onCreated={(c) => { load(); setOpenId(c.id); }} />}
      {openId && <CheckDrawer id={openId} onClose={() => { setOpenId(null); if (params.get('check')) router.replace('/quality'); }} onChanged={load} />}
    </div>
  );
}

function CheckDrawer({ id, onClose, onChanged }) {
  const toast = useToast();
  const { can } = useWorkspace();
  const [check, setCheck] = useState(null);
  const [results, setResults] = useState([]);
  const [note, setNote] = useState('');
  const [raise, setRaise] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get(`/quality/checks/${id}`).then((r) => {
      setCheck(r.data);
      setResults(r.data.results.map((p) => ({ ...p, passed: p.passed ?? null })));
    }).catch(() => {});
  }, [id]);

  const setPoint = (index, patch) => setResults((list) => list.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  const complete = results.length > 0 && results.every((p) => p.passed !== null);

  async function save() {
    setBusy(true);
    try {
      const r = await api.post(`/quality/checks/${id}/perform`, { results: results.map((p) => ({ label: p.label, passed: p.passed, note: p.note ?? '' })), note, raise_ncr: raise });
      setCheck({ ...r.data, ncrs: [] });
      toast.success(r.data.status === 'passed' ? 'Passed' : 'Recorded as failed');
      onChanged();
    } catch (err) {
      toast.error('Could not record', { description: err instanceof ApiError ? err.message : undefined });
    } finally {
      setBusy(false);
    }
  }

  const c = check;
  const pending = c?.status === 'pending' && can('quality.checks.perform');
  return (
    <Drawer open onClose={onClose} width="lg" title={c ? `${c.number} · ${c.product_name ?? 'Check'}` : 'Loading…'}
      subtitle={c ? `${titleCase(c.trigger)}${c.source_ref ? ` · ${c.source_ref}` : ''}${c.plan_name ? ` · ${c.plan_name}` : ''}` : undefined}
      badge={c && <Badge size="sm" tone={TONE[c.status]}>{titleCase(c.status)}</Badge>}
      footer={pending && <><div className="flex-1" /><Button variant="primary" loading={busy} disabled={!complete} onClick={save}>Record result</Button></>}>
      {c && (
        <div className="space-y-4">
          <ul className="space-y-2">
            {results.map((p, index) => (
              <li key={p.label} className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] p-3">
                <div className="flex items-center gap-2">
                  <span className="flex-1 text-sm font-medium">{p.label}</span>
                  {pending ? (
                    <>
                      <Button size="sm" variant={p.passed === true ? 'primary' : 'secondary'} icon={Check} onClick={() => setPoint(index, { passed: true })}>Pass</Button>
                      <Button size="sm" variant={p.passed === false ? 'danger' : 'secondary'} icon={X} onClick={() => setPoint(index, { passed: false })}>Fail</Button>
                    </>
                  ) : <Badge size="sm" tone={p.passed ? 'positive' : 'critical'}>{p.passed ? 'Pass' : 'Fail'}</Badge>}
                </div>
                {pending && p.passed === false && <Input className={cn('mt-2')} value={p.note ?? ''} onChange={(e) => setPoint(index, { note: e.target.value })} placeholder="What was wrong?" />}
                {!pending && p.note && <p className="mt-1 text-sm text-[var(--text-secondary)]">{p.note}</p>}
              </li>
            ))}
          </ul>
          {pending ? (
            <>
              <Field label="Notes">{(p) => <Textarea {...p} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
              {results.some((p) => p.passed === false) && <Checkbox label="Open a non-conformance report" description="Recommended: it tracks the root cause and corrective action." checked={raise} onChange={(e) => setRaise(e.target.checked)} />}
            </>
          ) : (
            <DetailGrid items={[{ label: 'Checked', value: c.performed_at ? relativeTime(c.performed_at) : null }, { label: 'Notes', value: c.note || null, full: true }]} />
          )}
          {c.ncrs?.length > 0 && (
            <div className="text-sm">Reports: {c.ncrs.map((n) => <Link key={n.id} href={`/quality/ncr?open=${n.id}`} className="mr-2 text-[var(--color-brand-600)] hover:underline">{n.number} ({titleCase(n.status)})</Link>)}</div>
          )}
        </div>
      )}
    </Drawer>
  );
}

function ManualCheck({ onClose, onCreated }) {
  const toast = useToast();
  const plans = useOptions('/quality/plans', { active: true, limit: 100 });
  const [product, setProduct] = useState(null);
  const [planId, setPlanId] = useState('');
  const [points, setPoints] = useState('');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post('/quality/checks', {
        product_id: product.id, plan_id: planId || undefined, source_ref: reference,
        checklist: planId ? undefined : points.split('\n').map((l) => l.trim()).filter(Boolean).map((label) => ({ label })),
      });
      toast.success(`${r.data.number} created`);
      onClose();
      onCreated(r.data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the check.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Manual quality check" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!product} onClick={submit}>Create</Button></>}>
      <div className="space-y-4">
        {error && <Alert tone="critical">{error}</Alert>}
        <Field label="Product">{() => <ProductPicker value={product?.id} label={product?.name} onPick={setProduct} autoFocus />}</Field>
        <Field label="Inspection plan">{(p) => <Select {...p} value={planId} onChange={(e) => setPlanId(e.target.value)}><option value="">None — list checkpoints below</option>{plans.map((pl) => <option key={pl.id} value={pl.id}>{pl.name}</option>)}</Select>}</Field>
        {!planId && <Field label="Checkpoints" hint="One per line">{(p) => <Textarea {...p} rows={4} value={points} onChange={(e) => setPoints(e.target.value)} placeholder={'Packaging intact\nLabel matches'} />}</Field>}
        <Field label="Reference">{(p) => <Input {...p} value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Batch, lot or customer complaint no." />}</Field>
      </div>
    </Modal>
  );
}
