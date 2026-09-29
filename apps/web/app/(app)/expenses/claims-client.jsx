'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Plus, ReceiptIndianRupee, Hourglass, CheckCircle2, Banknote, AlertTriangle } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { money, date, relativeTime } from '@/lib/format';
import { Can } from '@/lib/workspace';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Field } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { ListToolbar } from '@/components/data/list-shell';
import { StatTile } from '@/components/data/stat-tile';
import { Table, THead, TBody, TH, TR, TD, TableSkeleton } from '@/components/ui/table';
import { Avatar, Badge, Card, EmptyState, PageHeader, Alert } from '@/components/ui/primitives';
import { ClaimDrawer, CLAIM_TONE, CLAIM_LABEL } from '@/components/expenses/claim-drawer';

const STATUS_FILTER = {
  key: 'status',
  label: 'Status',
  options: Object.entries(CLAIM_LABEL).map(([value, label]) => ({ value, label })),
};

export default function ClaimsClient({ scope }) {
  const router = useRouter();
  const params = useSearchParams();
  const team = scope === 'team';
  const base = team ? '/expenses/approvals' : '/expenses';

  const [claims, setClaims] = useState(null);
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState({});
  const [openId, setOpenId] = useState(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (params.get('claim')) setOpenId(params.get('claim'));
    if (params.get('new') === '1') setCreating(true);
  }, [params]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await api.get('/expenses/claims', {
        query: { scope, q: search || undefined, status: filters.status },
      });
      setClaims(response.data);
      setMeta(response.meta);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load claims.');
    }
  }, [scope, search, filters]);

  useEffect(() => {
    const timer = setTimeout(load, search ? 280 : 0);
    return () => clearTimeout(timer);
  }, [load, search]);

  const close = () => { setOpenId(null); if (params.get('claim')) router.replace(base); };

  return (
    <div className="space-y-5">
      <PageHeader
        title={team ? 'Approvals' : 'My claims'}
        description={team
          ? 'Claims waiting on you come first. Approve, reject with a reason, then mark them paid.'
          : 'Add what you spent, attach receipts, submit. You will be notified when it is approved and paid.'}
        actions={!team && (
          <Can permission="expenses.claims.create">
            <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>New claim</Button>
          </Can>
        )}
      />

      {meta && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatTile label={team ? 'Waiting for approval' : 'Awaiting approval'} value={meta.pending} format="money" icon={Hourglass} tone="caution"
            hint={`${meta.pending_count} ${meta.pending_count === 1 ? 'claim' : 'claims'}`} />
          <StatTile label="Approved, not yet paid" value={meta.approved} format="money" icon={CheckCircle2} tone="brand" />
          <StatTile label="Reimbursed this month" value={meta.reimbursed_this_month} format="money" icon={Banknote} tone="positive" />
          <StatTile label={team ? 'Claims shown' : 'Claims'} value={claims?.length ?? 0} icon={ReceiptIndianRupee} />
        </div>
      )}

      <ListToolbar
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Title or EXP number…"
        filters={[STATUS_FILTER]}
        values={filters}
        onFilter={(key, value) => setFilters(value === undefined ? {} : { [key]: value })}
        onClear={() => setFilters({})}
      />

      {error && <Alert tone="critical">{error}</Alert>}

      {!claims ? <TableSkeleton rows={5} columns={5} /> : claims.length === 0 ? (
        <Card>
          <EmptyState
            icon={ReceiptIndianRupee}
            title={team ? 'Nothing to review' : 'No claims yet'}
            description={team ? 'Submitted claims from your team will appear here.' : 'Spent your own money on work? Claim it back here.'}
            action={!team && <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>New claim</Button>}
          />
        </Card>
      ) : (
        <Table>
          <THead>
            <tr>
              <TH width="6rem">Number</TH>
              <TH>Claim</TH>
              {team && <TH>Claimed by</TH>}
              <TH>Status</TH>
              <TH align="right">Items</TH>
              <TH align="right">Total</TH>
              <TH>Updated</TH>
            </tr>
          </THead>
          <TBody>
            {claims.map((c) => (
              <TR key={c.id} onClick={() => setOpenId(c.id)}>
                <TD numeric className="text-[var(--text-tertiary)]">{c.number}</TD>
                <TD>
                  <p className="flex items-center gap-1.5 font-medium">
                    {c.title}
                    {c.policy_warnings?.length > 0 && c.status === 'submitted' && (
                      <AlertTriangle className="size-3.5 text-[var(--color-caution-600)]" aria-label="Over a monthly limit" />
                    )}
                  </p>
                  {c.submitted_at && <p className="text-xs text-[var(--text-tertiary)]">Submitted {date(c.submitted_at)}</p>}
                </TD>
                {team && (
                  <TD><span className="flex items-center gap-2"><Avatar name={c.claimant_name ?? '?'} size="xs" />{c.claimant_name ?? 'Unknown'}</span></TD>
                )}
                <TD><Badge size="sm" tone={CLAIM_TONE[c.status]}>{CLAIM_LABEL[c.status]}</Badge></TD>
                <TD align="right" numeric>{c.line_count}</TD>
                <TD align="right" numeric className="font-medium">{money(c.total)}</TD>
                <TD className="text-[var(--text-secondary)]">{relativeTime(c.updated_at)}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}

      {creating && (
        <NewClaimModal
          onClose={() => { setCreating(false); if (params.get('new')) router.replace(base); }}
          onCreated={(claim) => { load(); setOpenId(claim.id); }}
        />
      )}
      {openId && <ClaimDrawer claimId={openId} onClose={close} onChanged={load} />}
    </div>
  );
}

function NewClaimModal({ onClose, onCreated }) {
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(event) {
    event?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await api.post('/expenses/claims', { title });
      toast.success(`${response.data.number} created`, { description: 'Now add the expenses.' });
      onClose();
      onCreated(response.data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the claim.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="New claim"
      description="One claim per trip, event or month — whatever your approver finds easiest to check."
      size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!title.trim()} onClick={submit}>Create</Button></>}
    >
      <form onSubmit={submit} className="space-y-3">
        {error && <Alert tone="critical">{error}</Alert>}
        <Field label="Title">
          {(p) => <Input {...p} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Education fair, Jaipur · October" data-autofocus />}
        </Field>
      </form>
    </Modal>
  );
}
