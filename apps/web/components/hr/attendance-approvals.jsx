'use client';

import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, XCircle, Clock3, Fingerprint, ArrowRight } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Textarea, Field } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Avatar, Badge, Card } from '@/components/ui/primitives';
import { date as fmtDate } from '@/lib/format';

const VIA = { hr: 'Marked by HR', check_in: 'Check-in button', portal: 'Employee request' };

const time = (value) => (value ? fmtDate(value, 'time') : null);

/** "present 9:05 am – 6:20 pm", or just "remote" when no times were given. */
function describe(status, checkIn, checkOut) {
  const label = String(status ?? '').replace('_', ' ');
  const from = time(checkIn);
  const to = time(checkOut);
  if (!from && !to) return label;
  return `${label} ${from ?? '?'} – ${to ?? '?'}`;
}

/**
 * Manual attendance waiting for a decision.
 *
 * Renders nothing when the queue is empty, so the attendance board only grows
 * this panel on the days it has something to say.
 */
export function AttendanceApprovals({ refreshKey, onChanged }) {
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [canApprove, setCanApprove] = useState(false);
  const [rejecting, setRejecting] = useState(null);
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    try {
      const response = await api.get('/hr/attendance/requests');
      setRows(response.data);
      setCanApprove(Boolean(response.meta?.can_approve));
    } catch {
      setRows([]);
    }
  }, []);

  useEffect(() => { load(); }, [load, refreshKey]);

  async function decide(row, decision, note) {
    setBusy(row.id);
    try {
      await api.post(`/hr/attendance/requests/${row.id}/decide`, { decision, note });
      toast.success(decision === 'approved' ? `${row.name}'s day approved` : 'Request rejected', {
        description: decision === 'approved' ? 'It now counts towards payroll.' : undefined,
      });
      setRejecting(null);
      await load();
      await onChanged?.();
    } catch (err) {
      toast.error('Could not decide that request', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setBusy(null);
    }
  }

  if (!rows.length) return null;

  return (
    <Card className="overflow-hidden border-[var(--color-caution-500)]/30">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-subtle)] bg-[var(--color-caution-50)] px-5 py-3 dark:bg-[rgb(245_158_11/0.08)]">
        <div className="flex items-center gap-2">
          <Clock3 className="size-4 text-[var(--color-caution-600)]" />
          <h3 className="text-md font-semibold">
            {rows.length} manual {rows.length === 1 ? 'entry' : 'entries'} waiting for approval
          </h3>
        </div>
        <p className="text-xs text-[var(--text-secondary)]">
          Punch-terminal days are recorded automatically. Typed-in days count only once approved.
        </p>
      </div>

      <div className="divide-y divide-[var(--border-subtle)]">
        {rows.map((row) => (
          <div key={row.id} className="flex flex-wrap items-center gap-4 px-5 py-3">
            <div className="flex min-w-[12rem] flex-1 items-center gap-2.5">
              <Avatar name={row.name} size="sm" />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{row.name}</p>
                <p className="truncate text-xs text-[var(--text-tertiary)]">
                  {fmtDate(row.on_date)} · {VIA[row.via] ?? row.via}
                </p>
              </div>
            </div>

            <div className="flex min-w-[14rem] items-center gap-2 text-sm">
              {row.current_status ? (
                <span className="text-[var(--text-tertiary)] line-through">
                  {describe(row.current_status, row.current_check_in, row.current_check_out)}
                </span>
              ) : (
                <span className="text-[var(--text-tertiary)]">nothing recorded</span>
              )}
              <ArrowRight className="size-3.5 shrink-0 text-[var(--text-tertiary)]" />
              <span className="font-medium">
                {describe(row.status, row.check_in_at, row.check_out_at)}
              </span>
              {row.overrides_device && (
                <Badge tone="caution" size="sm" title="The punch terminal recorded this day differently">
                  <Fingerprint className="size-3" />overrides device
                </Badge>
              )}
            </div>

            <p className="min-w-[10rem] flex-1 truncate text-sm text-[var(--text-secondary)]" title={row.reason ?? ''}>
              {row.reason ?? '—'}
            </p>

            {canApprove && (
              row.is_own ? (
                <Badge tone="neutral" size="sm">Your request — another approver decides</Badge>
              ) : (
                <div className="flex gap-1.5">
                  <Button
                    variant="ghost" size="sm" icon={XCircle}
                    onClick={() => setRejecting(row)} disabled={busy === row.id}
                  >
                    Reject
                  </Button>
                  <Button
                    variant="primary" size="sm" icon={CheckCircle2}
                    onClick={() => decide(row, 'approved')} loading={busy === row.id}
                  >
                    Approve
                  </Button>
                </div>
              )
            )}
          </div>
        ))}
      </div>

      {rejecting && (
        <RejectModal
          row={rejecting}
          busy={busy === rejecting.id}
          onClose={() => setRejecting(null)}
          onConfirm={(note) => decide(rejecting, 'rejected', note)}
        />
      )}
    </Card>
  );
}

function RejectModal({ row, busy, onClose, onConfirm }) {
  const [note, setNote] = useState('');
  return (
    <Modal
      open
      onClose={onClose}
      title={`Reject ${row.name}'s request?`}
      description="They will see your reason. The day stays as it was."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="danger" onClick={() => onConfirm(note.trim())} disabled={!note.trim()} loading={busy}>
            Reject
          </Button>
        </>
      }
    >
      <Field label="Reason" required>
        <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} autoFocus />
      </Field>
    </Modal>
  );
}
