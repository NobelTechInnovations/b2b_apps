'use client';

import { useCallback, useEffect, useState } from 'react';
import { BellRing, Check, Phone, MessageCircle, RefreshCw, X, CalendarCheck2, PhoneCall } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { relativeTime } from '@/lib/format';
import { useWorkspace } from '@/lib/workspace';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/input';
import { Card, EmptyState, PageHeader, Alert, Skeleton, Avatar } from '@/components/ui/primitives';
import { Chip, StageBadge, TZ, dueLabel, telLink, useLeadsMeta, whatsappLink, OUTCOME_LABEL } from '@/components/leads/lead-kit';
import { LeadDrawer, FollowupModal } from '@/components/leads/lead-drawer';

const BUCKETS = [
  { key: 'overdue', label: 'Overdue', empty: 'Nothing overdue. Nicely done.' },
  { key: 'today', label: 'Today', empty: 'No follow-ups left for today.' },
  { key: 'upcoming', label: 'Upcoming', empty: 'Nothing booked after today yet.' },
  { key: 'done', label: 'Done this week', empty: 'Follow-ups you finish appear here.' },
];
const KIND = { call: 'Call', whatsapp: 'WhatsApp', email: 'Email', meeting: 'Meeting', visit: 'Visit', task: 'Follow up' };

export default function FollowupsClient() {
  const toast = useToast();
  const { can } = useWorkspace();
  const { meta } = useLeadsMeta();
  const [bucket, setBucket] = useState('today');
  const [owner, setOwner] = useState('me');
  const [rows, setRows] = useState([]);
  const [counts, setCounts] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [moving, setMoving] = useState(null);
  const [chosen, setChosen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.get('/leads/followups', { query: { bucket, owner, tz: TZ, limit: 100 } });
      setRows(response.data);
      setCounts(response.meta.counts);
      // Land on whatever needs doing first.
      if (!chosen) {
        setChosen(true);
        if (response.meta.counts.overdue && bucket === 'today' && !response.meta.counts.today) setBucket('overdue');
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load follow-ups.');
    } finally {
      setLoading(false);
    }
  }, [bucket, owner, chosen]);

  useEffect(() => { load(); }, [load]);

  async function act(f, action, body) {
    try {
      if (action === 'move') await api.patch(`/leads/followups/${f.id}`, body);
      else await api.post(`/leads/followups/${f.id}/${action}`, {});
      toast.success(action === 'done' ? 'Done' : action === 'cancel' ? 'Cancelled' : 'Rescheduled');
      setMoving(null);
      load();
    } catch (err) {
      toast.error('Could not update it', { description: err instanceof ApiError ? err.message : undefined });
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Follow-ups"
        description="Who to call, message or meet — overdue first. You get a reminder ten minutes before each one."
        actions={meta?.sees_all && (
          <Select value={owner} onChange={(e) => setOwner(e.target.value)} className="w-auto" aria-label="Whose follow-ups">
            <option value="me">My follow-ups</option>
            <option value="all">Everyone’s</option>
            {(meta.team ?? []).map((m) => <option key={m.user_id} value={m.user_id}>{m.name ?? m.email}</option>)}
          </Select>
        )}
      />

      <div className="flex flex-wrap gap-1.5">
        {BUCKETS.map((b) => (
          <Chip key={b.key} active={bucket === b.key} tone={b.key === 'overdue' && counts.overdue ? 'critical' : undefined} onClick={() => setBucket(b.key)}>
            {b.label}<span className="ml-1.5 tabular opacity-70">{counts[b.key] ?? 0}</span>
          </Chip>
        ))}
      </div>

      {error && <Alert tone="critical">{error}</Alert>}

      {loading && !rows.length ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-20" />)}</div>
      ) : rows.length === 0 ? (
        <Card><EmptyState icon={bucket === 'done' ? CalendarCheck2 : BellRing} title={BUCKETS.find((b) => b.key === bucket).empty} description="Log a call on any lead to book its next follow-up." /></Card>
      ) : (
        <ul className="space-y-2">
          {rows.map((f) => {
            const due = dueLabel(f.due_at);
            const wa = whatsappLink(f.phone, `Hi ${f.first_name ?? ''},`.trim());
            const open = !f.completed_at;
            return (
              <li key={f.id}>
                <Card className={cn('flex flex-wrap items-center gap-3 px-4 py-3', open && due.overdue && 'border-[rgb(239_68_68/0.35)]')}>
                  <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => setOpenId(f.related_id)}>
                    <Avatar name={f.lead_name} size="md" />
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 font-medium">
                        {f.lead_name}
                        <StageBadge name={f.stage_name} color={f.stage_color} />
                      </p>
                      <p className="truncate text-sm text-[var(--text-secondary)]">
                        <span className={cn(open && due.overdue && 'font-medium text-[var(--color-critical-600)]')}>{KIND[f.kind] ?? 'Follow up'} · {open ? due.text : `done ${relativeTime(f.completed_at)}`}</span>
                        {f.company_name ? ` · ${f.company_name}` : ''}
                        {f.last_call_outcome ? ` · last: ${OUTCOME_LABEL[f.last_call_outcome]}` : ''}
                      </p>
                      {f.body && <p className="truncate text-xs text-[var(--text-tertiary)]">{f.body}</p>}
                      {owner !== 'me' && f.assignee && <p className="text-xs text-[var(--text-tertiary)]">For {f.assignee.name}</p>}
                    </div>
                  </button>
                  <div className="flex items-center gap-1.5">
                    {f.phone && <a href={telLink(f.phone)}><Button size="sm" variant="primary" icon={Phone}>Call</Button></a>}
                    {wa && <a href={wa} target="_blank" rel="noreferrer"><Button size="sm" variant="secondary" icon={MessageCircle} aria-label="WhatsApp" /></a>}
                    <Button size="sm" variant="secondary" icon={PhoneCall} onClick={() => setOpenId(f.related_id)}>Log</Button>
                    {open && can('leads.followups.edit') && (
                      <>
                        <Button size="icon-sm" variant="ghost" title="Mark done" aria-label="Mark done" onClick={() => act(f, 'done')}><Check className="size-4" /></Button>
                        <Button size="icon-sm" variant="ghost" title="Reschedule" aria-label="Reschedule" onClick={() => setMoving(f)}><RefreshCw className="size-3.5" /></Button>
                        <Button size="icon-sm" variant="ghost" title="Cancel" aria-label="Cancel" onClick={() => act(f, 'cancel')}><X className="size-4" /></Button>
                      </>
                    )}
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      {openId && <LeadDrawer leadId={openId} meta={meta} onClose={() => setOpenId(null)} onChanged={load} />}
      <FollowupModal open={Boolean(moving)} title="Reschedule" initial={moving} onClose={() => setMoving(null)} onSave={(body) => act(moving, 'move', body)} />
    </div>
  );
}
