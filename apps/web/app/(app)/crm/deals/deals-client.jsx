'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { Plus, HandCoins, Trophy, Building2, CalendarClock } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { money, date, relativeTime } from '@/lib/format';
import { Can, useWorkspace } from '@/lib/workspace';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Field, Select, Textarea } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Drawer, DetailGrid } from '@/components/data/drawer';
import { ListToolbar, Pagination } from '@/components/data/list-shell';
import { StatTile } from '@/components/data/stat-tile';
import { Table, THead, TBody, TH, TR, TD, TableSkeleton } from '@/components/ui/table';
import { Badge, Card, EmptyState, PageHeader, Alert } from '@/components/ui/primitives';

const STATUS_TONE = { open: 'info', won: 'positive', lost: 'critical' };

const FILTERS = [
  {
    key: 'status',
    label: 'Status',
    options: [
      { value: 'open', label: 'Open' }, { value: 'won', label: 'Won' }, { value: 'lost', label: 'Lost' },
    ],
  },
];

export default function DealsClient() {
  const router = useRouter();
  const params = useSearchParams();
  const { can } = useWorkspace();

  const [deals, setDeals] = useState([]);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState({});
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(params.get('new') === '1');
  const [selectedId, setSelectedId] = useState(params.get('open'));

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.get('/crm/deals', {
        query: { ...filters, q: search || undefined, page, limit: 25 },
      });
      setDeals(response.data);
      setMeta(response.meta);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load deals.');
    } finally {
      setLoading(false);
    }
  }, [filters, search, page]);

  useEffect(() => {
    const timer = setTimeout(load, search ? 280 : 0);
    return () => clearTimeout(timer);
  }, [load, search]);

  const summary = meta?.summary;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Deals"
        description="Every opportunity, open and closed."
        actions={
          <Can permission="crm.deals.create">
            <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>New deal</Button>
          </Can>
        }
      />

      {summary && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatTile label="Open deals" value={summary.open_count} icon={HandCoins} />
          <StatTile label="Open value" value={summary.open_value} format="money" tone="brand" />
          <StatTile label="Won this month" value={summary.won_this_month} format="money" tone="positive" icon={Trophy} />
          <StatTile label="Won all time" value={summary.won_count} icon={Trophy} />
        </div>
      )}

      <ListToolbar
        search={search}
        onSearch={(v) => { setSearch(v); setPage(1); }}
        searchPlaceholder="Search deals or companies…"
        filters={FILTERS}
        values={filters}
        onFilter={(key, value) => {
          setFilters((c) => {
            const next = { ...c };
            if (value === undefined) delete next[key]; else next[key] = value;
            return next;
          });
          setPage(1);
        }}
        onClear={() => { setFilters({}); setPage(1); }}
      />

      {error && <Alert tone="critical">{error}</Alert>}

      {loading ? (
        <TableSkeleton rows={6} columns={6} />
      ) : deals.length === 0 ? (
        <Card>
          <EmptyState
            icon={HandCoins}
            title={search || Object.keys(filters).length ? 'No deals match' : 'No deals yet'}
            description={
              search || Object.keys(filters).length
                ? 'Try a different search or clear your filters.'
                : 'Convert a qualified lead, or create a deal directly.'
            }
            action={
              can('crm.deals.create') && (
                <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>Create a deal</Button>
              )
            }
          />
        </Card>
      ) : (
        <>
          <Table>
            <THead>
              <tr>
                <TH>Deal</TH>
                <TH>Company</TH>
                <TH>Stage</TH>
                <TH align="right">Value</TH>
                <TH align="right">Weighted</TH>
                <TH>Expected close</TH>
                <TH>Status</TH>
              </tr>
            </THead>
            <TBody>
              {deals.map((deal) => (
                <TR key={deal.id} onClick={() => setSelectedId(deal.id)}>
                  <TD className="font-medium">{deal.title}</TD>
                  <TD className="text-[var(--text-secondary)]">{deal.company_name ?? '—'}</TD>
                  <TD>
                    <Badge size="sm" tone="neutral" dot>{deal.stage_name}</Badge>
                  </TD>
                  <TD align="right" numeric className="font-medium">{money(deal.value, deal.currency)}</TD>
                  <TD align="right" numeric className="text-[var(--text-secondary)]">
                    {money(deal.weighted_value, deal.currency)}
                  </TD>
                  <TD className="text-[var(--text-secondary)]">
                    {deal.expected_close_date ? date(deal.expected_close_date) : '—'}
                  </TD>
                  <TD><Badge size="sm" tone={STATUS_TONE[deal.status]}>{deal.status}</Badge></TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <Pagination meta={meta} onPage={setPage} />
        </>
      )}

      <CreateDealModal
        open={creating}
        onClose={() => { setCreating(false); router.replace('/crm/deals'); }}
        onCreated={load}
      />

      <DealDrawer
        dealId={selectedId}
        onClose={() => { setSelectedId(null); router.replace('/crm/deals'); }}
        onChanged={load}
      />
    </div>
  );
}

function DealDrawer({ dealId, onClose, onChanged }) {
  const [deal, setDeal] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!dealId) { setDeal(null); return; }
    setLoading(true);
    api.get(`/crm/deals/${dealId}`)
      .then((r) => setDeal(r.data))
      .catch(() => setDeal(null))
      .finally(() => setLoading(false));
  }, [dealId]);

  if (!dealId) return null;

  return (
    <Drawer
      open
      onClose={onClose}
      title={deal?.title ?? 'Deal'}
      subtitle={deal?.company_name}
      badge={deal && <Badge size="sm" tone={STATUS_TONE[deal.status]}>{deal.status}</Badge>}
    >
      {loading || !deal ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => <div key={i} className="skeleton h-16 w-full" />)}
        </div>
      ) : (
        <div className="space-y-6">
          <div className="panel p-4">
            <p className="text-xs text-[var(--text-tertiary)]">Deal value</p>
            <p className="mt-1 text-2xl font-semibold tabular tracking-[-0.025em]">
              {money(deal.value, deal.currency)}
            </p>
            <p className="mt-1 text-xs text-[var(--text-secondary)]">
              {money(deal.weighted_value, deal.currency)} weighted at {deal.probability}%
            </p>
          </div>

          <DetailGrid
            items={[
              { label: 'Stage', value: deal.stage_name },
              { label: 'Probability', value: `${deal.probability}%` },
              { label: 'Company', value: deal.company_name },
              { label: 'Contact', value: deal.contact_name },
              { label: 'Contact email', value: deal.contact_email },
              { label: 'Contact phone', value: deal.contact_phone },
              { label: 'Expected close', value: deal.expected_close_date ? date(deal.expected_close_date) : null },
              { label: 'Closed', value: deal.closed_at ? relativeTime(deal.closed_at) : null },
              { label: 'Source', value: deal.source },
              { label: 'Lost reason', value: deal.lost_reason },
              { label: 'Description', value: deal.description, full: true },
            ]}
          />

          <div>
            <h3 className="mb-2 text-sm font-medium text-[var(--text-secondary)]">Stage history</h3>
            <ul className="space-y-2.5">
              {deal.stage_history.map((entry) => (
                <li key={entry.id} className="flex gap-2.5">
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-[var(--color-brand-400)]" />
                  <div className="min-w-0">
                    <p className="text-base">
                      {entry.from_stage_name ? `${entry.from_stage_name} → ` : 'Created in '}
                      <strong>{entry.to_stage_name}</strong>
                    </p>
                    <p className="text-xs text-[var(--text-tertiary)]">{relativeTime(entry.moved_at)}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </Drawer>
  );
}

function CreateDealModal({ open, onClose, onCreated }) {
  const toast = useToast();
  const [form, setForm] = useState({});
  const [companies, setCompanies] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return;
    api.get('/crm/companies', { query: { limit: 100 } })
      .then((r) => setCompanies(r.data))
      .catch(() => setCompanies([]));
  }, [open]);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload = { ...form };
      if (payload.value) payload.value = Number(payload.value).toFixed(2);
      for (const key of Object.keys(payload)) if (payload[key] === '') delete payload[key];

      const response = await api.post('/crm/deals', payload);
      toast.success(`${response.data.title} created`);
      setForm({});
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create that deal.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New deal"
      description="It starts in the first stage of your default pipeline."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={busy} icon={Plus}>Create deal</Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert tone="critical">{error}</Alert>}

        <Field label="Deal title" required>
          {(p) => <Input {...p} value={form.title ?? ''} onChange={set('title')} required data-autofocus placeholder="Acme — annual licence" />}
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Value" hint="In rupees">
            {(p) => <Input {...p} type="number" min="0" step="0.01" value={form.value ?? ''} onChange={set('value')} />}
          </Field>
          <Field label="Expected close">
            {(p) => <Input {...p} type="date" value={form.expected_close_date ?? ''} onChange={set('expected_close_date')} />}
          </Field>
        </div>

        <Field label="Company" hint={companies.length ? undefined : 'No companies yet — you can link one later.'}>
          {(p) => (
            <Select {...p} value={form.company_id ?? ''} onChange={set('company_id')} disabled={!companies.length}>
              <option value="">No company</option>
              {companies.map((company) => (
                <option key={company.id} value={company.id}>{company.name}</option>
              ))}
            </Select>
          )}
        </Field>

        <Field label="Description">
          {(p) => <Textarea {...p} rows={3} value={form.description ?? ''} onChange={set('description')} />}
        </Field>
      </form>
    </Modal>
  );
}
