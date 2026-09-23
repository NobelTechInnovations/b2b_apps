'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Plus, Target, Users, Star, TrendingUp, TrendingDown, Send, CheckCircle2,
  ChevronRight, BarChart3, UserPlus, Flag,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Can, useWorkspace } from '@/lib/workspace';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Field, Select, Textarea } from '@/components/ui/input';
import { Modal, ConfirmModal } from '@/components/ui/modal';
import { Drawer } from '@/components/data/drawer';
import { Table, THead, TBody, TH, TR, TD, TableSkeleton } from '@/components/ui/table';
import { StatTile } from '@/components/data/stat-tile';
import {
  Avatar, Badge, Card, EmptyState, PageHeader, Alert, Skeleton, Divider,
} from '@/components/ui/primitives';
import { date as fmtDate } from '@/lib/format';
import { cn } from '@/lib/cn';

const STATUS = {
  draft: { label: 'Draft', tone: 'neutral', hint: 'Nobody can see it yet' },
  self_review: { label: 'Self-reviews open', tone: 'caution', hint: 'Employees are writing theirs' },
  manager_review: { label: 'With managers', tone: 'caution', hint: 'Managers are writing theirs' },
  calibration: { label: 'Calibration', tone: 'info', hint: 'Ratings being agreed' },
  shared: { label: 'Shared', tone: 'positive', hint: 'Employees can read their review' },
  closed: { label: 'Closed', tone: 'neutral', hint: 'Finished' },
};

const RECOMMENDATION = {
  exceeds: { label: 'Exceeds', tone: 'positive' },
  meets: { label: 'Meets', tone: 'positive' },
  below: { label: 'Below', tone: 'caution' },
  promote: { label: 'Promote', tone: 'positive' },
  improve: { label: 'Improvement plan', tone: 'caution' },
  exit: { label: 'Under review', tone: 'critical' },
};

export default function PerformanceClient() {
  const toast = useToast();
  const { can } = useWorkspace();

  const [cycles, setCycles] = useState([]);
  const [report, setReport] = useState(null);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [creating, setCreating] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const [advancing, setAdvancing] = useState(null);
  const [openReview, setOpenReview] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await api.get('/hr/performance/cycles');
      setCycles(response.data);
      setSelected((current) => current ?? response.data[0]?.id ?? null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load review cycles.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const loadReport = useCallback(async () => {
    if (!selected) { setReport(null); return; }
    try {
      const response = await api.get('/hr/performance/report', { query: { cycle_id: selected } });
      setReport(response);
    } catch {
      setReport(null);
    }
  }, [selected]);

  useEffect(() => { loadReport(); }, [loadReport]);

  const cycle = useMemo(() => cycles.find((c) => c.id === selected), [cycles, selected]);

  async function advance(status) {
    setBusy(true);
    try {
      await api.post(`/hr/performance/cycles/${selected}/status`, { status });
      toast.success(`Cycle moved to ${STATUS[status]?.label.toLowerCase() ?? status}`, {
        description: status === 'shared'
          ? 'Everybody can now read their review in the portal.'
          : undefined,
      });
      setAdvancing(null);
      await load();
      await loadReport();
    } catch (err) {
      toast.error('Could not move the cycle on', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Performance"
        description="Review cycles, ratings and the report they produce."
        actions={
          <Can permission="hr.performance.manage">
            <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>New cycle</Button>
          </Can>
        }
      />

      {error && <Alert tone="critical">{error}</Alert>}

      {loading ? (
        <Skeleton className="h-64 w-full" />
      ) : cycles.length === 0 ? (
        <Card>
          <EmptyState
            icon={Target}
            title="No review cycles yet"
            description="A cycle collects a self-review and a manager review for everybody over a period, then shares the result."
            action={can('hr.performance.manage') && (
              <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>Start a cycle</Button>
            )}
          />
        </Card>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {cycles.map((item) => (
              <button
                key={item.id}
                onClick={() => setSelected(item.id)}
                className={cn(
                  'flex items-center gap-2 rounded-[var(--radius-md)] border px-3 py-1.5 text-sm transition-colors',
                  selected === item.id
                    ? 'border-[var(--color-brand-500)] bg-[var(--color-brand-50)] text-[var(--color-brand-700)] dark:bg-[rgb(99_102_241/0.12)] dark:text-[var(--color-brand-300)]'
                    : 'border-[var(--border-subtle)] hover:border-[var(--border-default)]',
                )}
              >
                {item.name}
                <Badge tone={STATUS[item.status]?.tone} size="sm">{STATUS[item.status]?.label}</Badge>
              </button>
            ))}
          </div>

          {cycle && (
            <>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <StatTile label="People in this cycle" value={cycle.review_count} icon={Users} />
                <StatTile
                  label="Self-reviews in"
                  value={cycle.self_submitted}
                  icon={Send}
                  hint={`of ${cycle.review_count}`}
                  tone={cycle.self_submitted === cycle.review_count && cycle.review_count > 0 ? 'positive' : 'neutral'}
                />
                <StatTile
                  label="Manager reviews in"
                  value={cycle.manager_submitted}
                  icon={CheckCircle2}
                  hint={`of ${cycle.review_count}`}
                  tone={cycle.manager_submitted === cycle.review_count && cycle.review_count > 0 ? 'positive' : 'neutral'}
                />
                <StatTile
                  label="Average rating"
                  value={cycle.average_rating ? Number(cycle.average_rating) : '—'}
                  format="raw"
                  icon={Star}
                  tone="brand"
                  hint={cycle.average_rating ? `out of ${cycle.rating_scale}` : 'not rated yet'}
                />
              </div>

              <Card className="p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm text-[var(--text-secondary)]">
                      {fmtDate(cycle.period_start)} – {fmtDate(cycle.period_end)} ·{' '}
                      {STATUS[cycle.status]?.hint}
                    </p>
                    {cycle.self_review_due && cycle.status === 'self_review' && (
                      <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">
                        Self-reviews due {fmtDate(cycle.self_review_due)}
                      </p>
                    )}
                  </div>

                  <Can permission="hr.performance.manage">
                    <div className="flex flex-wrap gap-2">
                      {cycle.review_count === 0 && (
                        <Button variant="secondary" size="sm" icon={UserPlus} onClick={() => setEnrolling(true)}>
                          Enrol people
                        </Button>
                      )}
                      {(cycle.next_statuses ?? []).map((next) => (
                        <Button
                          key={next}
                          variant={next === 'shared' ? 'primary' : 'secondary'}
                          size="sm"
                          onClick={() => setAdvancing(next)}
                        >
                          {next === 'shared' ? 'Share with everyone' : `Move to ${STATUS[next]?.label.toLowerCase()}`}
                        </Button>
                      ))}
                    </div>
                  </Can>
                </div>
              </Card>

              {report && (
                <ReportTable
                  report={report}
                  scale={cycle.rating_scale}
                  canReview={can('hr.performance.review') && !['shared', 'closed'].includes(cycle.status)}
                  onOpen={setOpenReview}
                />
              )}
            </>
          )}
        </>
      )}

      {creating && (
        <CycleModal onClose={() => setCreating(false)} onDone={async (id) => {
          setCreating(false);
          await load();
          setSelected(id);
        }} />
      )}

      {enrolling && (
        <EnrolModal
          cycleId={selected}
          onClose={() => setEnrolling(false)}
          onDone={async () => { setEnrolling(false); await load(); await loadReport(); }}
        />
      )}

      {openReview && (
        <ReviewDrawer
          reviewId={openReview}
          scale={cycle?.rating_scale ?? 5}
          competencies={cycle?.competencies ?? []}
          onClose={() => setOpenReview(null)}
          onChanged={async () => { await load(); await loadReport(); }}
        />
      )}

      <ConfirmModal
        open={Boolean(advancing)}
        onClose={() => setAdvancing(null)}
        onConfirm={() => advance(advancing)}
        title={advancing === 'shared' ? 'Share this cycle with everyone?' : `Move to ${STATUS[advancing]?.label ?? ''}?`}
        description={
          advancing === 'shared'
            ? 'Every employee will be able to read their rating and their manager’s comments in the portal. Ratings can no longer be changed after this.'
            : STATUS[advancing]?.hint
        }
        confirmLabel={advancing === 'shared' ? 'Share' : 'Move on'}
        danger={advancing === 'shared'}
        loading={busy}
      />
    </div>
  );
}

/* ── the report ─────────────────────────────────────────────────────────── */
function ReportTable({ report, scale, canReview, onOpen }) {
  const { data, meta } = report;

  if (!data.length) {
    return (
      <Card>
        <EmptyState
          icon={Users}
          title="Nobody is enrolled yet"
          description="Enrol people into this cycle and their reviews appear here."
        />
      </Card>
    );
  }

  const bands = Array.from({ length: scale }, (_, i) => i + 1);
  const peak = Math.max(1, ...bands.map((b) => meta.distribution?.[b] ?? 0));

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-1.5 text-md font-semibold">
              <BarChart3 className="size-4" />Rating distribution
            </h3>
            <p className="mt-0.5 text-sm text-[var(--text-secondary)]">
              {meta.rated} of {meta.headcount} rated · {meta.acknowledged} acknowledged
            </p>
          </div>
          <div className="flex flex-wrap justify-end gap-1.5">
            {Object.entries(meta.by_recommendation ?? {}).map(([key, count]) => (
              <Badge key={key} tone={RECOMMENDATION[key]?.tone ?? 'neutral'} size="sm">
                {RECOMMENDATION[key]?.label ?? key}: {count}
              </Badge>
            ))}
          </div>
        </div>

        <div className="mt-5 flex items-end gap-2" style={{ height: 80 }}>
          {bands.map((band) => {
            const count = meta.distribution?.[band] ?? 0;
            return (
              <div key={band} className="flex flex-1 flex-col items-center justify-end gap-1.5">
                <span className="text-xs font-semibold tabular">{count || ''}</span>
                <div
                  className={cn(
                    'w-full rounded-t-[var(--radius-xs)]',
                    count ? 'bg-[var(--color-brand-500)]' : 'bg-[var(--surface-sunken)]',
                  )}
                  style={{ height: Math.max(3, (count / peak) * 60) }}
                />
                <span className="text-xs text-[var(--text-tertiary)]">{band}</span>
              </div>
            );
          })}
        </div>
      </Card>

      <Card>
        <div className="border-b border-[var(--border-subtle)] px-5 py-3">
          <h3 className="text-md font-semibold">Everybody in this cycle</h3>
        </div>
        <Table>
          <THead>
            <tr>
              <TH>Person</TH>
              <TH>Reviewer</TH>
              <TH align="right">Rating</TH>
              <TH align="right">Change</TH>
              <TH align="right">Goals</TH>
              <TH>Outcome</TH>
              <TH>{''}</TH>
            </tr>
          </THead>
          <TBody>
            {data.map((row) => (
              <TR key={row.review_id} onClick={() => onOpen(row.review_id)}>
                <TD>
                  <div className="flex items-center gap-2.5">
                    <Avatar name={row.name} size="sm" />
                    <div className="min-w-0">
                      <p className="truncate font-medium">{row.name}</p>
                      <p className="truncate text-xs text-[var(--text-tertiary)]">
                        {row.designation ?? row.employee_code}
                        {row.department_name && ` · ${row.department_name}`}
                      </p>
                    </div>
                  </div>
                </TD>
                <TD className="text-[var(--text-secondary)]">{row.reviewer_name ?? '—'}</TD>
                <TD align="right" numeric className="font-semibold">
                  {row.overall_rating != null ? `${Number(row.overall_rating)} / ${scale}` : '—'}
                </TD>
                <TD align="right" numeric>
                  {row.rating_change == null ? (
                    <span className="text-[var(--text-tertiary)]">—</span>
                  ) : (
                    <span className={cn(
                      'inline-flex items-center gap-0.5 font-medium',
                      row.rating_change > 0 && 'text-[var(--color-positive-600)]',
                      row.rating_change < 0 && 'text-[var(--color-critical-600)]',
                    )}>
                      {row.rating_change > 0 ? <TrendingUp className="size-3" />
                        : row.rating_change < 0 ? <TrendingDown className="size-3" /> : null}
                      {row.rating_change > 0 ? '+' : ''}{row.rating_change}
                    </span>
                  )}
                </TD>
                <TD align="right" numeric>
                  {row.goals_total
                    ? `${row.goals_achieved}/${row.goals_total}`
                    : <span className="text-[var(--text-tertiary)]">—</span>}
                </TD>
                <TD>
                  {row.recommendation
                    ? <Badge tone={RECOMMENDATION[row.recommendation]?.tone} size="sm">
                        {RECOMMENDATION[row.recommendation]?.label}
                      </Badge>
                    : <Badge tone="neutral" size="sm">{row.status.replace('_', ' ')}</Badge>}
                </TD>
                <TD>
                  <div className="flex items-center gap-1.5">
                    {row.acknowledged_at && (
                      <CheckCircle2 className="size-3.5 text-[var(--color-positive-600)]" />
                    )}
                    <ChevronRight className="size-4 text-[var(--text-tertiary)]" />
                  </div>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>
    </div>
  );
}

/* ── one review ─────────────────────────────────────────────────────────── */
function ReviewDrawer({ reviewId, scale, competencies, onClose, onChanged }) {
  const toast = useToast();
  const [review, setReview] = useState(null);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get('/hr/performance/reviews', { query: { limit: 100 } })
      .then((r) => {
        const found = r.data.find((x) => x.id === reviewId);
        setReview(found ?? null);
        setForm({
          manager_scores: found?.manager_scores ?? {},
          manager_comments: found?.manager_comments ?? '',
          strengths: found?.strengths ?? '',
          improvements: found?.improvements ?? '',
          overall_rating: found?.overall_rating ?? '',
          recommendation: found?.recommendation ?? '',
        });
      })
      .catch(() => setReview(null));
  }, [reviewId]);

  const editable = review && !['shared', 'closed'].includes(review.cycle_status);
  const list = Array.isArray(competencies) && competencies.length
    ? competencies
    : (Array.isArray(review?.competencies) ? review.competencies : []);

  async function save(submit) {
    setBusy(true);
    try {
      await api.patch(`/hr/performance/reviews/${reviewId}`, {
        manager_scores: form.manager_scores,
        manager_comments: form.manager_comments || undefined,
        strengths: form.strengths || undefined,
        improvements: form.improvements || undefined,
        overall_rating: form.overall_rating === '' ? undefined : Number(form.overall_rating),
        recommendation: form.recommendation || undefined,
        submit,
      });
      toast.success(submit ? 'Review submitted' : 'Saved');
      await onChanged();
      if (submit) onClose();
    } catch (err) {
      toast.error('Could not save that review', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      open
      onClose={onClose}
      title={review?.name ?? 'Review'}
      subtitle={review ? `${review.cycle_name} · ${review.designation ?? review.employee_code}` : undefined}
      badge={review?.acknowledged_at && <Badge tone="positive">Acknowledged</Badge>}
      width="lg"
      footer={
        editable && form && (
          <div className="flex w-full items-center gap-2">
            <Button variant="ghost" onClick={onClose} disabled={busy}>Close</Button>
            <div className="flex-1" />
            <Button variant="secondary" onClick={() => save(false)} loading={busy}>Save</Button>
            <Button variant="primary" onClick={() => save(true)} disabled={!form.overall_rating} loading={busy}>
              Submit review
            </Button>
          </div>
        )
      }
    >
      {!review || !form ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <div className="space-y-5">
          {review.self_comments ? (
            <section>
              <h4 className="text-sm font-semibold">What they said about themselves</h4>
              <p className="mt-1.5 whitespace-pre-line rounded-[var(--radius-lg)] bg-[var(--surface-sunken)] p-3 text-sm text-[var(--text-secondary)]">
                {review.self_comments}
              </p>
              {Object.keys(review.self_scores ?? {}).length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {Object.entries(review.self_scores).map(([key, value]) => (
                    <Badge key={key} tone="neutral" size="sm">{key}: {value}</Badge>
                  ))}
                </div>
              )}
            </section>
          ) : (
            <Alert tone="info">They have not written their self-review yet.</Alert>
          )}

          {!editable && <Alert tone="caution">This cycle has been shared. Ratings are frozen.</Alert>}

          <Divider label="Your assessment" />

          {list.length > 0 && (
            <div className="space-y-3">
              {list.map((competency) => (
                <div key={competency} className="flex flex-wrap items-center justify-between gap-3">
                  <span className="text-sm font-medium">{competency}</span>
                  <div className="flex gap-1">
                    {Array.from({ length: scale }, (_, i) => i + 1).map((value) => (
                      <button
                        key={value}
                        type="button"
                        disabled={!editable}
                        onClick={() => setForm((f) => ({
                          ...f,
                          manager_scores: { ...f.manager_scores, [competency]: value },
                        }))}
                        className={cn(
                          'flex size-8 items-center justify-center rounded-[var(--radius-md)] text-sm font-semibold transition-colors disabled:opacity-60',
                          form.manager_scores?.[competency] === value
                            ? 'bg-[var(--color-brand-600)] text-white'
                            : 'bg-[var(--surface-sunken)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]',
                        )}
                      >
                        {value}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Overall rating" required hint={`Out of ${scale}`}>
              <Input
                type="number" min="0" max={scale} step="0.5" disabled={!editable}
                value={form.overall_rating}
                onChange={(e) => setForm((f) => ({ ...f, overall_rating: e.target.value }))}
              />
            </Field>
            <Field label="Outcome">
              <Select
                value={form.recommendation} disabled={!editable}
                onChange={(e) => setForm((f) => ({ ...f, recommendation: e.target.value }))}
              >
                <option value="">Choose…</option>
                {Object.entries(RECOMMENDATION).map(([key, meta]) => (
                  <option key={key} value={key}>{meta.label}</option>
                ))}
              </Select>
            </Field>
          </div>

          <Field label="Your comments">
            <Textarea
              rows={4} disabled={!editable} value={form.manager_comments}
              onChange={(e) => setForm((f) => ({ ...f, manager_comments: e.target.value }))}
              placeholder="What they did, in concrete terms."
            />
          </Field>
          <Field label="Strengths">
            <Textarea
              rows={2} disabled={!editable} value={form.strengths}
              onChange={(e) => setForm((f) => ({ ...f, strengths: e.target.value }))}
            />
          </Field>
          <Field label="Where to focus next">
            <Textarea
              rows={2} disabled={!editable} value={form.improvements}
              onChange={(e) => setForm((f) => ({ ...f, improvements: e.target.value }))}
            />
          </Field>

          {review.acknowledgement && (
            <>
              <Divider label="Their response" />
              <p className="whitespace-pre-line text-sm text-[var(--text-secondary)]">
                {review.acknowledgement}
              </p>
            </>
          )}
        </div>
      )}
    </Drawer>
  );
}

/* ── creating a cycle ───────────────────────────────────────────────────── */
function CycleModal({ onClose, onDone }) {
  const toast = useToast();
  const year = new Date().getFullYear();
  const [form, setForm] = useState({
    name: `H1 ${year}`,
    period_start: `${year}-01-01`,
    period_end: `${year}-06-30`,
    self_review_due: '',
    rating_scale: 5,
    competencies: 'Quality of work\nOwnership\nCollaboration\nCommunication\nDependability',
    instructions: '',
  });
  const [busy, setBusy] = useState(false);
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  async function submit() {
    setBusy(true);
    try {
      const response = await api.post('/hr/performance/cycles', {
        name: form.name.trim(),
        period_start: form.period_start,
        period_end: form.period_end,
        self_review_due: form.self_review_due || undefined,
        rating_scale: Number(form.rating_scale),
        competencies: form.competencies.split('\n').map((c) => c.trim()).filter(Boolean),
        instructions: form.instructions?.trim() || undefined,
      });
      toast.success(`${response.data.name} created`, { description: 'Enrol people to get started.' });
      await onDone(response.data.id);
    } catch (err) {
      toast.error('Could not create that cycle', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="New review cycle"
      description="A cycle collects a self-review and a manager review over a period, then shares the result."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={!form.name.trim()} loading={busy}>
            Create cycle
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" required className="sm:col-span-2">
          <Input value={form.name} onChange={(e) => set('name', e.target.value)} autoFocus />
        </Field>
        <Field label="Period start" required>
          <Input type="date" value={form.period_start} onChange={(e) => set('period_start', e.target.value)} />
        </Field>
        <Field label="Period end" required>
          <Input type="date" value={form.period_end} onChange={(e) => set('period_end', e.target.value)} />
        </Field>
        <Field label="Self-reviews due">
          <Input type="date" value={form.self_review_due} onChange={(e) => set('self_review_due', e.target.value)} />
        </Field>
        <Field label="Rating scale" hint="Out of how many">
          <Select value={form.rating_scale} onChange={(e) => set('rating_scale', e.target.value)}>
            {[3, 4, 5, 10].map((n) => <option key={n} value={n}>{n}</option>)}
          </Select>
        </Field>
        <Field label="What people are rated on" hint="One per line" className="sm:col-span-2">
          <Textarea rows={5} value={form.competencies} onChange={(e) => set('competencies', e.target.value)} />
        </Field>
        <Field label="Instructions" hint="Shown to everybody writing a review" className="sm:col-span-2">
          <Textarea rows={2} value={form.instructions} onChange={(e) => set('instructions', e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function EnrolModal({ cycleId, onClose, onDone }) {
  const toast = useToast();
  const [departments, setDepartments] = useState([]);
  const [scope, setScope] = useState('everyone');
  const [departmentId, setDepartmentId] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get('/hr/departments').then((r) => setDepartments(r.data)).catch(() => setDepartments([]));
  }, []);

  async function submit() {
    setBusy(true);
    try {
      const response = await api.post(`/hr/performance/cycles/${cycleId}/enrol`,
        scope === 'everyone' ? { everyone: true } : { department_id: departmentId });
      const missing = response.meta?.without_a_manager ?? 0;
      toast.success(`${response.data.enrolled} enrolled`, {
        description: missing
          ? `${missing} ${missing === 1 ? 'person has' : 'people have'} no manager to review them — set one in Employees.`
          : undefined,
      });
      await onDone();
    } catch (err) {
      toast.error('Could not enrol anybody', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Enrol people"
      description="Each person's reviewer is taken from their reporting line at the moment you enrol them."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button
            variant="primary" onClick={submit} loading={busy}
            disabled={scope === 'department' && !departmentId}
          >
            Enrol
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Who">
          <Select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="everyone">Everybody currently employed</option>
            <option value="department">One department</option>
          </Select>
        </Field>
        {scope === 'department' && (
          <Field label="Department" required>
            <Select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
              <option value="">Choose…</option>
              {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </Select>
          </Field>
        )}
        <Alert tone="info" icon={Flag}>
          Anybody already enrolled is left alone, so you can safely enrol again after hiring.
        </Alert>
      </div>
    </Modal>
  );
}
