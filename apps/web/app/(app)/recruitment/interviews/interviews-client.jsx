'use client';

import { useCallback, useEffect, useState } from 'react';
import { CalendarClock, Video, Phone, MapPin } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { date } from '@/lib/format';
import { useWorkspace } from '@/lib/workspace';
import { usePeople, titleCase } from '@/lib/people';
import { Button } from '@/components/ui/button';
import { Card, EmptyState, PageHeader, Alert, Badge, Skeleton } from '@/components/ui/primitives';
import { CandidateDrawer, FeedbackModal, candidateName } from '@/components/recruitment/candidate-drawer';

const MODE_ICON = { video: Video, phone: Phone, in_person: MapPin };
const STATUS_TONE = { scheduled: 'info', completed: 'positive', cancelled: 'neutral', no_show: 'critical' };

export default function InterviewsClient() {
  const { user } = useWorkspace();
  const { people, nameOf } = usePeople('/recruitment/people');
  const [mine, setMine] = useState(true);
  const [upcoming, setUpcoming] = useState(true);
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [feedback, setFeedback] = useState(null);
  const [openId, setOpenId] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const today = new Date().toISOString().slice(0, 10);
      const response = await api.get('/recruitment/interviews', {
        query: { mine: mine || undefined, status: upcoming ? 'scheduled' : undefined, from: upcoming ? today : undefined },
      });
      // Past interviews read newest first; upcoming ones soonest first.
      setRows(upcoming ? response.data : [...response.data].reverse());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load interviews.');
    }
  }, [mine, upcoming]);

  useEffect(() => { load(); }, [load]);

  // Group by day so a week of interviews scans like a calendar.
  const days = (rows ?? []).reduce((acc, row) => {
    const key = new Date(row.scheduled_at).toDateString();
    (acc[key] ??= []).push(row);
    return acc;
  }, {});

  return (
    <div className="space-y-5">
      <PageHeader title="Interviews" description="Who you are meeting, when, and whose feedback is still missing." />

      <div className="flex flex-wrap gap-2">
        <Toggle on={mine} onClick={() => setMine(true)}>Mine</Toggle>
        <Toggle on={!mine} onClick={() => setMine(false)}>Everyone’s</Toggle>
        <span className="mx-1 w-px bg-[var(--border-subtle)]" />
        <Toggle on={upcoming} onClick={() => setUpcoming(true)}>Upcoming</Toggle>
        <Toggle on={!upcoming} onClick={() => setUpcoming(false)}>All</Toggle>
      </div>

      {error && <Alert tone="critical">{error}</Alert>}

      {!rows ? <Skeleton className="h-40 w-full" /> : rows.length === 0 ? (
        <Card>
          <EmptyState icon={CalendarClock} title="No interviews" description={mine ? 'Nothing on your calendar. Schedule one from a candidate in the pipeline.' : 'Nothing scheduled yet.'} />
        </Card>
      ) : (
        <div className="space-y-5">
          {Object.entries(days).map(([day, list]) => (
            <section key={day}>
              <h2 className="mb-2 text-sm font-semibold text-[var(--text-secondary)]">{date(list[0].scheduled_at, 'long')}</h2>
              <Card className="divide-y divide-[var(--border-subtle)]">
                {list.map((i) => {
                  const Icon = MODE_ICON[i.mode] ?? CalendarClock;
                  const pendingFeedback = i.status === 'scheduled' && new Date(i.scheduled_at) < new Date();
                  return (
                    <div key={i.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                      <span className="w-16 tabular text-sm font-medium">{date(i.scheduled_at, 'time')}</span>
                      <Icon className="size-4 text-[var(--text-tertiary)]" />
                      <button className="min-w-0 flex-1 text-left" onClick={() => setOpenId(i.candidate_id)}>
                        <p className="truncate font-medium hover:underline">{candidateName(i)}</p>
                        <p className="truncate text-xs text-[var(--text-tertiary)]">
                          {i.job_title} · {i.duration_minutes}m · {nameOf(i.interviewer_id)}{i.location ? ` · ${i.location}` : ''}
                        </p>
                      </button>
                      <Badge size="sm" tone={pendingFeedback ? 'caution' : STATUS_TONE[i.status]}>
                        {pendingFeedback ? 'Feedback due' : titleCase(i.status)}
                      </Badge>
                      {i.status === 'scheduled' && i.location?.startsWith('https://') && (
                        <a href={i.location} target="_blank" rel="noreferrer noopener"><Button size="sm" variant="secondary" icon={Video}>Join</Button></a>
                      )}
                      {i.status === 'scheduled' && i.interviewer_id === user?.id && (
                        <Button size="sm" variant={pendingFeedback ? 'primary' : 'ghost'} onClick={() => setFeedback(i)}>Feedback</Button>
                      )}
                    </div>
                  );
                })}
              </Card>
            </section>
          ))}
        </div>
      )}

      {feedback && <FeedbackModal interview={feedback} onClose={() => setFeedback(null)} onSaved={load} />}
      {openId && <CandidateDrawer candidateId={openId} people={people} nameOf={nameOf} onClose={() => setOpenId(null)} onChanged={load} />}
    </div>
  );
}

function Toggle({ on, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'rounded-full px-3 py-1 text-sm font-medium ring-1 ring-inset transition-colors',
        on ? 'bg-[var(--color-brand-50)] text-[var(--color-brand-700)] ring-[var(--color-brand-200)] dark:bg-[rgb(99_102_241/0.12)] dark:text-[var(--color-brand-300)]'
          : 'text-[var(--text-secondary)] ring-[var(--border-default)] hover:bg-[var(--surface-hover)]',
      )}
    >
      {children}
    </button>
  );
}
