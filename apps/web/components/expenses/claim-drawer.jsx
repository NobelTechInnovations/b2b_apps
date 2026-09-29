'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus, Send, Undo2, Check, X, Banknote, Trash2, Paperclip, AlertTriangle, Pencil } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { money, date, relativeTime } from '@/lib/format';
import { useWorkspace } from '@/lib/workspace';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Field, Select, Textarea } from '@/components/ui/input';
import { Modal, ConfirmModal } from '@/components/ui/modal';
import { Drawer } from '@/components/data/drawer';
import { Table, THead, TBody, TH, TR, TD } from '@/components/ui/table';
import { Badge, Alert } from '@/components/ui/primitives';

export const CLAIM_TONE = { draft: 'neutral', submitted: 'caution', approved: 'brand', rejected: 'critical', reimbursed: 'positive' };
export const CLAIM_LABEL = { draft: 'Draft', submitted: 'Awaiting approval', approved: 'Approved', rejected: 'Rejected', reimbursed: 'Reimbursed' };

/**
 * One claim, from either side of the desk: the claimant adds lines and
 * submits; an approver decides; finance marks it paid. What shows depends
 * on whose claim it is and what the viewer may do — the server enforces the
 * same rules regardless.
 */
export function ClaimDrawer({ claimId, onClose, onChanged }) {
  const toast = useToast();
  const { can, user } = useWorkspace();
  const [claim, setClaim] = useState(null);
  const [categories, setCategories] = useState([]);
  const [error, setError] = useState(null);
  const [editingLine, setEditingLine] = useState(null); // {} for new
  const [deciding, setDeciding] = useState(null); // 'approve' | 'reject' | 'reimburse'
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState(null);

  const load = useCallback(async () => {
    try {
      setClaim((await api.get(`/expenses/claims/${claimId}`)).data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not open that claim.');
    }
  }, [claimId]);

  useEffect(() => { setClaim(null); setError(null); load(); }, [load]);
  useEffect(() => { api.get('/expenses/categories').then((r) => setCategories(r.data)).catch(() => {}); }, []);

  const refresh = async () => { await load(); onChanged?.(); };

  async function act(path, body, success) {
    setBusy(true);
    try {
      await api.post(`/expenses/claims/${claimId}/${path}`, body ?? {});
      toast.success(success);
      setDeciding(null);
      await refresh();
    } catch (err) {
      toast.error('That did not work', { description: err instanceof ApiError ? err.message : undefined });
    } finally {
      setBusy(false);
    }
  }

  async function removeLine(line) {
    try {
      await api.del(`/expenses/claims/${claimId}/lines/${line.id}`);
      await refresh();
    } catch (err) {
      toast.error('Could not remove that expense', { description: err instanceof ApiError ? err.message : undefined });
    }
  }

  async function saveTitle() {
    if (!title?.trim() || title === claim.title) { setTitle(null); return; }
    try {
      await api.patch(`/expenses/claims/${claimId}`, { title });
      setTitle(null);
      await refresh();
    } catch (err) {
      toast.error('Could not rename', { description: err instanceof ApiError ? err.message : undefined });
    }
  }

  async function removeClaim() {
    try {
      await api.del(`/expenses/claims/${claimId}`);
      toast.success('Draft deleted');
      onChanged?.();
      onClose();
    } catch (err) {
      toast.error('Could not delete', { description: err instanceof ApiError ? err.message : undefined });
    }
  }

  const c = claim;
  const mine = c && c.user_id === user?.id;
  const editable = mine && ['draft', 'rejected'].includes(c.status);
  const needsReceipt = (line) => categories.find((x) => x.id === line.category_id)?.requires_receipt && !line.receipt_url && !line.receipt_document_id;

  const footer = c && (
    <>
      {editable && c.status === 'draft' && <Button variant="danger-ghost" icon={Trash2} onClick={() => setConfirmDelete(true)}>Delete draft</Button>}
      <div className="flex-1" />
      {editable && <Button variant="primary" icon={Send} loading={busy} disabled={!c.lines.length} onClick={() => act('submit', null, 'Submitted for approval')}>{c.status === 'rejected' ? 'Resubmit' : 'Submit'}</Button>}
      {mine && c.status === 'submitted' && <Button variant="secondary" icon={Undo2} loading={busy} onClick={() => act('withdraw', null, 'Withdrawn to draft')}>Withdraw</Button>}
      {c.can_decide && c.status === 'submitted' && (
        <>
          <Button variant="ghost" icon={X} onClick={() => setDeciding('reject')}>Reject</Button>
          <Button variant="primary" icon={Check} onClick={() => setDeciding('approve')}>Approve</Button>
        </>
      )}
      {!mine && c.status === 'approved' && can('expenses.claims.reimburse') && (
        <Button variant="primary" icon={Banknote} onClick={() => setDeciding('reimburse')}>Mark reimbursed</Button>
      )}
    </>
  );

  return (
    <Drawer
      open
      onClose={onClose}
      width="lg"
      title={c ? c.title : 'Loading…'}
      subtitle={c ? `${c.number}${c.claimant_name && !mine ? ` · ${c.claimant_name}` : ''} · created ${relativeTime(c.created_at)}` : undefined}
      badge={c && <Badge size="sm" tone={CLAIM_TONE[c.status]}>{CLAIM_LABEL[c.status]}</Badge>}
      footer={footer}
    >
      {error && <Alert tone="critical">{error}</Alert>}
      {c && (
        <div className="space-y-5">
          <div className="flex items-end justify-between gap-4">
            <div>
              <p className="text-xs text-[var(--text-tertiary)]">Total</p>
              <p className="metric text-3xl font-semibold">{money(c.total)}</p>
            </div>
            {editable && (title === null ? (
              <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setTitle(c.title)}>Rename</Button>
            ) : (
              <form onSubmit={(e) => { e.preventDefault(); saveTitle(); }} className="flex gap-2">
                <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus className="w-64" />
                <Button type="submit" size="sm">Save</Button>
              </form>
            ))}
          </div>

          {c.status === 'rejected' && c.decision_note && (
            <Alert tone="critical" title="Rejected">{c.decision_note} {mine && 'Fix the claim and resubmit it.'}</Alert>
          )}
          {c.status === 'approved' && <Alert tone="info">Approved{c.decision_note ? `: ${c.decision_note}` : ''}. Waiting for reimbursement.</Alert>}
          {c.status === 'reimbursed' && (
            <Alert tone="positive">Reimbursed {relativeTime(c.reimbursed_at)}{c.payment_reference ? ` · ref ${c.payment_reference}` : ''}.</Alert>
          )}
          {c.policy_warnings?.length > 0 && ['submitted', 'approved'].includes(c.status) && (
            <Alert tone="caution" icon={AlertTriangle} title="Over a monthly limit">
              {c.policy_warnings.map((w) => `${w.category}: ${money(w.claimed)} claimed in ${w.month} against a ${money(w.limit)} limit`).join('; ')}.
            </Alert>
          )}

          <div>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-medium text-[var(--text-secondary)]">Expenses</h3>
              {editable && <Button size="sm" variant="secondary" icon={Plus} onClick={() => setEditingLine({})}>Add expense</Button>}
            </div>
            {c.lines.length === 0 ? (
              <button
                disabled={!editable}
                onClick={() => setEditingLine({})}
                className="w-full rounded-[var(--radius-lg)] border border-dashed border-[var(--border-default)] px-3 py-8 text-center text-sm text-[var(--text-tertiary)] enabled:hover:bg-[var(--surface-hover)]"
              >
                {editable ? 'Add the first expense — a cab, a meal, a SIM recharge.' : 'No expenses on this claim.'}
              </button>
            ) : (
              <Table>
                <THead>
                  <tr><TH>Date</TH><TH>Category</TH><TH>Details</TH><TH align="right">Amount</TH><TH width="5rem" /></tr>
                </THead>
                <TBody>
                  {c.lines.map((l) => (
                    <TR key={l.id} onClick={editable ? () => setEditingLine(l) : undefined}>
                      <TD className="whitespace-nowrap">{date(l.spent_on, 'short')}</TD>
                      <TD>{l.category_name}</TD>
                      <TD>
                        <p className="max-w-[14rem] truncate">{l.merchant || l.description || '—'}</p>
                        {l.merchant && l.description && <p className="max-w-[14rem] truncate text-xs text-[var(--text-tertiary)]">{l.description}</p>}
                      </TD>
                      <TD align="right" numeric>{money(l.amount)}</TD>
                      <TD align="right">
                        <span className="inline-flex items-center gap-1">
                          {l.receipt_url ? (
                            <a href={l.receipt_url} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()} title="Receipt" className="text-[var(--color-brand-600)]"><Paperclip className="size-4" /></a>
                          ) : needsReceipt(l) ? <Badge size="sm" tone="critical">Receipt</Badge> : null}
                          {editable && (
                            <button onClick={(e) => { e.stopPropagation(); removeLine(l); }} aria-label="Remove expense" className="rounded p-1 text-[var(--text-tertiary)] hover:text-[var(--color-critical-600)]">
                              <Trash2 className="size-3.5" />
                            </button>
                          )}
                        </span>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </div>

          {c.submitted_at && (
            <p className="text-xs text-[var(--text-tertiary)]">
              Submitted {date(c.submitted_at, 'datetime')}{c.decided_at ? ` · decided ${date(c.decided_at, 'datetime')}` : ''}
            </p>
          )}
        </div>
      )}

      {editingLine && c && (
        <LineModal claimId={claimId} line={editingLine} categories={categories.filter((x) => x.active || x.id === editingLine.category_id)} onClose={() => setEditingLine(null)} onSaved={refresh} />
      )}
      {deciding && c && (
        <DecisionModal mode={deciding} claim={c} busy={busy} onClose={() => setDeciding(null)}
          onConfirm={(note) => (deciding === 'reimburse'
            ? act('reimburse', { reference: note }, 'Marked reimbursed')
            : act('decision', { decision: deciding, note: note || undefined }, deciding === 'approve' ? 'Claim approved' : 'Claim rejected'))}
        />
      )}
      <ConfirmModal open={confirmDelete} onClose={() => setConfirmDelete(false)} onConfirm={removeClaim} danger title="Delete this draft?" description="Its expenses are deleted too." confirmLabel="Delete" />
    </Drawer>
  );
}

function LineModal({ claimId, line, categories, onClose, onSaved }) {
  const isNew = !line.id;
  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({
    spent_on: line.spent_on ?? today, category_id: line.category_id ?? categories[0]?.id ?? '',
    amount: line.amount ?? '', merchant: line.merchant ?? '', description: line.description ?? '', receipt_url: line.receipt_url ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const category = categories.find((x) => x.id === form.category_id);

  async function submit(event) {
    event?.preventDefault();
    setBusy(true);
    setErrors({});
    setFormError(null);
    const payload = {
      spent_on: form.spent_on, category_id: form.category_id, amount: Number(form.amount).toFixed(2),
      merchant: form.merchant || null, description: form.description, receipt_url: form.receipt_url || null,
    };
    try {
      if (isNew) await api.post(`/expenses/claims/${claimId}/lines`, payload);
      else await api.patch(`/expenses/claims/${claimId}/lines/${line.id}`, payload);
      onClose();
      await onSaved();
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fieldErrors).length) setErrors(err.fieldErrors);
      else setFormError(err instanceof ApiError ? err.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={isNew ? 'Add expense' : 'Edit expense'}
      size="lg"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={submit} disabled={!form.amount || !form.category_id}>{isNew ? 'Add' : 'Save'}</Button></>}
    >
      <form onSubmit={submit} className="space-y-4">
        {formError && <Alert tone="critical">{formError}</Alert>}
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Date" error={errors.spent_on}>{(p) => <Input {...p} type="date" max={today} value={form.spent_on} onChange={set('spent_on')} />}</Field>
          <Field label="Category">
            {(p) => <Select {...p} value={form.category_id} onChange={set('category_id')}>{categories.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}
          </Field>
          <Field label="Amount (₹)" required error={errors.amount}>{(p) => <Input {...p} type="number" min="0.01" step="0.01" value={form.amount} onChange={set('amount')} data-autofocus />}</Field>
        </div>
        {category?.monthly_limit && <p className="text-xs text-[var(--text-tertiary)]">{category.name} has a monthly limit of {money(category.monthly_limit)}.</p>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Merchant">{(p) => <Input {...p} value={form.merchant} onChange={set('merchant')} placeholder="Uber, Haldiram’s…" />}</Field>
          <Field label={category?.requires_receipt ? 'Receipt link (required)' : 'Receipt link'} error={errors.receipt_url} hint="A photo or PDF link from Drive, Photos or the Documents app">
            {(p) => <Input {...p} type="url" value={form.receipt_url} onChange={set('receipt_url')} placeholder="https://" />}
          </Field>
        </div>
        <Field label="What was it for?">{(p) => <Textarea {...p} rows={2} value={form.description} onChange={set('description')} />}</Field>
      </form>
    </Modal>
  );
}

function DecisionModal({ mode, claim, busy, onClose, onConfirm }) {
  const [note, setNote] = useState('');
  const copy = {
    approve: { title: `Approve ${money(claim.total)}?`, label: 'Note for the claimant (optional)', button: 'Approve', variant: 'primary' },
    reject: { title: 'Reject this claim?', label: 'Why? The claimant sees this.', button: 'Reject', variant: 'danger' },
    reimburse: { title: `Mark ${money(claim.total)} as paid?`, label: 'Payment reference (UTR, UPI ref, cheque no.)', button: 'Mark reimbursed', variant: 'primary' },
  }[mode];
  return (
    <Modal
      open
      onClose={onClose}
      title={copy.title}
      description={`${claim.number} · ${claim.title}${claim.claimant_name ? ` · ${claim.claimant_name}` : ''}`}
      size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant={copy.variant} loading={busy} disabled={mode === 'reject' && !note.trim()} onClick={() => onConfirm(note)}>{copy.button}</Button></>}
    >
      <Field label={copy.label}>
        {(p) => (mode === 'reimburse'
          ? <Input {...p} value={note} onChange={(e) => setNote(e.target.value)} data-autofocus />
          : <Textarea {...p} rows={3} value={note} onChange={(e) => setNote(e.target.value)} data-autofocus />)}
      </Field>
    </Modal>
  );
}
