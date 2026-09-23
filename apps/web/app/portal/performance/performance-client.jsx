'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Target, CheckCircle2, Star, MessageSquare, TrendingUp, Lock, Send,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Textarea, Field, Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Badge, Card, EmptyState, Alert, Skeleton, Divider } from '@/components/ui/primitives';
import { date as fmtDate } from '@/lib/format';
import { cn } from '@/lib/cn';

const CYCLE_LABEL = {
  draft: 'Not open yet',
  self_review: 'Your self-review is open',
  manager_review: 'With your manager',
  calibration: 'Being finalised',
  shared: 'Ready to read',
  closed: 'Closed',
};

const RECOMMENDATION = {
  exceeds: { label: 'Exceeds expectations', tone: 'positive' },
  meets: { label: 'Meets expectations', tone: 'positive' },
  below: { label: 'Below expectations', tone: 'caution' },
  promote: { label: 'Recommended for promotion', tone: 'positive' },
  improve: { label: 'Improvement plan', tone: 'caution' },
  exit: { label: 'Under review', tone: 'critical' },
};

export default function PortalPerformance() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selfReview, setSelfReview] = useState(null);
  const [acknowledging, setAcknowledging] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await api.get('/hr/me/performance');
      setData(response.data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load your reviews.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return <div className="space-y-4">{[0, 1].map((i) => <Skeleton key={i} className="h-40 w-full" />)}</div>;
  }

  const reviews = data?.reviews ?? [];
  const goals = data?.goals ?? [];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-[-0.02em]">Performance</h1>
        <p className="mt-1 text-base text-[var(--text-secondary)]">
          Your reviews and the goals they are measured against.
        </p>
      </div>

      {error && <Alert tone="critical">{error}</Alert>}

      {goals.length > 0 && (
        <Card>
          <div className="border-b border-[var(--border-subtle)] px-5 py-3">
            <h2 className="text-md font-semibold">Your goals</h2>
          </div>
          <div className="divide-y divide-[var(--border-subtle)]">
            {goals.map((goal) => (
              <GoalRow key={goal.id} goal={goal} onChanged={load} />
            ))}
          </div>
        </Card>
      )}

      {reviews.length === 0 ? (
        <Card>
          <EmptyState
            icon={Target}
            title="No reviews yet"
            description="When your employer opens a review cycle, your self-review and your manager's feedback appear here."
          />
        </Card>
      ) : (
        <div className="space-y-4">
          {reviews.map((review) => (
            <ReviewCard
              key={review.id}
              review={review}
              onSelfReview={() => setSelfReview(review)}
              onAcknowledge={() => setAcknowledging(review)}
            />
          ))}
        </div>
      )}

      {selfReview && (
        <SelfReviewModal
          review={selfReview}
          onClose={() => setSelfReview(null)}
          onDone={async () => { setSelfReview(null); await load(); }}
        />
      )}

      {acknowledging && (
        <AcknowledgeModal
          review={acknowledging}
          onClose={() => setAcknowledging(null)}
          onDone={async () => {
            setAcknowledging(null);
            await load();
            toast.success('Review acknowledged');
          }}
        />
      )}
    </div>
  );
}

function ReviewCard({ review, onSelfReview, onAcknowledge }) {
  const shared = ['shared', 'acknowledged'].includes(review.status);
  const canSelfReview = review.cycle_status === 'self_review' && !review.self_comments;
  const scale = review.rating_scale ?? 5;

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-md font-semibold">{review.cycle_name}</h3>
          <p className="mt-0.5 text-sm text-[var(--text-secondary)]">
            {fmtDate(review.period_start)} – {fmtDate(review.period_end)}
          </p>
        </div>
        <Badge tone={shared ? 'positive' : review.cycle_status === 'self_review' ? 'caution' : 'neutral'}>
          {CYCLE_LABEL[review.cycle_status] ?? review.cycle_status}
        </Badge>
      </div>

      {shared && review.overall_rating != null && (
        <div className="mt-4 flex flex-wrap items-center gap-4 rounded-[var(--radius-lg)] bg-[var(--surface-sunken)] p-4">
          <div>
            <p className="text-xs text-[var(--text-secondary)]">Overall rating</p>
            <p className="metric mt-0.5 text-2xl font-semibold tabular">
              {Number(review.overall_rating)}
              <span className="ml-1 text-sm font-normal text-[var(--text-tertiary)]">of {scale}</span>
            </p>
          </div>
          <div className="flex gap-0.5">
            {Array.from({ length: scale }, (_, i) => (
              <Star
                key={i}
                className={cn(
                  'size-4',
                  i < Math.round(Number(review.overall_rating))
                    ? 'fill-[var(--color-caution-500)] text-[var(--color-caution-500)]'
                    : 'text-[var(--border-default)]',
                )}
              />
            ))}
          </div>
          {review.recommendation && (
            <Badge tone={RECOMMENDATION[review.recommendation]?.tone ?? 'neutral'} className="ml-auto">
              {RECOMMENDATION[review.recommendation]?.label ?? review.recommendation}
            </Badge>
          )}
        </div>
      )}

      {review.self_comments && (
        <Section icon={MessageSquare} title="What you said">
          {review.self_comments}
        </Section>
      )}

      {shared ? (
        <>
          {review.manager_comments && (
            <Section icon={MessageSquare} title="What your manager said">
              {review.manager_comments}
            </Section>
          )}
          {review.strengths && (
            <Section icon={TrendingUp} title="Strengths">{review.strengths}</Section>
          )}
          {review.improvements && (
            <Section icon={Target} title="Where to focus next">{review.improvements}</Section>
          )}
        </>
      ) : (
        review.self_comments && (
          <p className="mt-4 flex items-center gap-1.5 text-sm text-[var(--text-tertiary)]">
            <Lock className="size-3.5" />
            Your manager&apos;s feedback appears here once the cycle is shared.
          </p>
        )
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-[var(--border-subtle)] pt-4">
        {canSelfReview && (
          <Button variant="primary" size="sm" icon={Send} onClick={onSelfReview}>
            Write your self-review
          </Button>
        )}
        {review.cycle_status === 'self_review' && review.self_comments && (
          <Badge tone="positive" size="sm">
            <CheckCircle2 className="size-3" />Self-review submitted
          </Badge>
        )}
        {review.status === 'shared' && (
          <Button variant="primary" size="sm" icon={CheckCircle2} onClick={onAcknowledge}>
            Acknowledge
          </Button>
        )}
        {review.acknowledged_at && (
          <Badge tone="positive" size="sm">
            <CheckCircle2 className="size-3" />
            Acknowledged {fmtDate(review.acknowledged_at)}
          </Badge>
        )}
        {review.self_review_due && review.cycle_status === 'self_review' && !review.self_comments && (
          <span className="text-xs text-[var(--text-tertiary)]">
            Due by {fmtDate(review.self_review_due)}
          </span>
        )}
      </div>
    </Card>
  );
}

function Section({ icon: Icon, title, children }) {
  return (
    <div className="mt-4">
      <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)]">
        <Icon className="size-3.5" />{title}
      </p>
      <p className="mt-1.5 whitespace-pre-line text-sm text-[var(--text-secondary)]">{children}</p>
    </div>
  );
}

function GoalRow({ goal, onChanged }) {
  const toast = useToast();
  const [progress, setProgress] = useState(goal.progress);
  const [saving, setSaving] = useState(false);

  const dirty = progress !== goal.progress;

  async function save() {
    setSaving(true);
    try {
      await api.patch(`/hr/me/goals/${goal.id}`, { progress: Number(progress) });
      toast.success('Progress updated');
      await onChanged();
    } catch (err) {
      toast.error('Could not update that goal', {
        description: err instanceof ApiError ? err.message : undefined,
      });
      setProgress(goal.progress);
    } finally {
      setSaving(false);
    }
  }

  const TONE = { achieved: 'positive', missed: 'critical', dropped: 'neutral', active: 'info' };

  return (
    <div className="px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-medium">{goal.title}</p>
          {goal.description && (
            <p className="mt-0.5 text-sm text-[var(--text-secondary)]">{goal.description}</p>
          )}
          <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-[var(--text-tertiary)]">
            {goal.metric && <span>{goal.metric}</span>}
            {goal.target_value && (
              <span>Target {Number(goal.target_value)}{goal.unit ? ` ${goal.unit}` : ''}</span>
            )}
            {goal.due_on && <span>Due {fmtDate(goal.due_on)}</span>}
          </p>
        </div>
        <Badge tone={TONE[goal.status] ?? 'neutral'} size="sm">{goal.status}</Badge>
      </div>

      {goal.status === 'active' && (
        <div className="mt-3 flex items-center gap-3">
          <input
            type="range" min="0" max="100" step="5"
            value={progress}
            onChange={(e) => setProgress(Number(e.target.value))}
            className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-[var(--surface-sunken)] accent-[var(--color-brand-600)]"
          />
          <span className="w-10 shrink-0 text-right text-sm font-semibold tabular">{progress}%</span>
          {dirty && (
            <Button variant="secondary" size="sm" onClick={save} loading={saving}>Save</Button>
          )}
        </div>
      )}
    </div>
  );
}

function SelfReviewModal({ review, onClose, onDone }) {
  const toast = useToast();
  const competencies = Array.isArray(review.competencies) ? review.competencies : [];
  const scale = review.rating_scale ?? 5;

  const [scores, setScores] = useState({});
  const [comments, setComments] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(andSubmit) {
    setBusy(true);
    try {
      await api.post(`/hr/me/performance/${review.id}/self`, {
        scores,
        comments: comments.trim() || undefined,
        submit: andSubmit,
      });
      toast.success(andSubmit ? 'Self-review submitted' : 'Draft saved');
      await onDone();
    } catch (err) {
      toast.error('Could not save your review', {
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
      title="Your self-review"
      description={review.instructions
        ?? 'Rate yourself honestly against each area, then add anything your manager should know.'}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="secondary" onClick={() => submit(false)} disabled={busy}>Save draft</Button>
          <Button variant="primary" onClick={() => submit(true)} disabled={!comments.trim()} loading={busy}>
            Submit
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {competencies.map((competency) => (
          <div key={competency} className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-sm font-medium">{competency}</span>
            <div className="flex gap-1">
              {Array.from({ length: scale }, (_, i) => i + 1).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setScores((s) => ({ ...s, [competency]: value }))}
                  className={cn(
                    'flex size-8 items-center justify-center rounded-[var(--radius-md)] text-sm font-semibold transition-colors',
                    scores[competency] === value
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

        <Divider />

        <Field label="What went well, and what was hard" required>
          <Textarea
            rows={6}
            value={comments}
            onChange={(e) => setComments(e.target.value)}
            placeholder="Be specific. Concrete examples are more useful to your manager than adjectives."
          />
        </Field>
      </div>
    </Modal>
  );
}

function AcknowledgeModal({ review, onClose, onDone }) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await api.post(`/hr/me/performance/${review.id}/acknowledge`, {
        note: note.trim() || undefined,
      });
      await onDone();
    } catch (err) {
      toast.error('Could not acknowledge that review', {
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
      title="Acknowledge your review"
      description="Confirming that you have read it. This does not mean you agree with it — add a note if you want to say something."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={busy}>Acknowledge</Button>
        </>
      }
    >
      <Field label="Your response" hint="Optional, and kept with the review">
        <Textarea rows={4} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </Modal>
  );
}
