import { EVENTS } from '@nexus/contracts/events';

/**
 * Which events become notifications, for whom, saying what.
 *
 * Each rule returns a list of `{ users, title, body, link }`. `users` is
 * either a list of user ids or `{ permission }`, which is resolved to
 * everybody in the workspace holding that permission — so "someone needs
 * approving" reaches exactly the people who can approve, and nobody else.
 *
 * The person who caused an event is never notified about it. That is enforced
 * once, by the consumer, rather than remembered in every rule here.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-09-22` → `22 Sep`. Rules speak in human dates, not ISO. */
export function shortDate(value) {
  const iso = typeof value === 'string' ? value.slice(0, 10) : null;
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
  const [, month, day] = iso.split('-').map(Number);
  return `${day} ${MONTHS[month - 1]}`;
}

const span = (from, to) =>
  (!to || from === to ? shortDate(from) : `${shortDate(from)} – ${shortDate(to)}`);

export const RULES = {
  // ── attendance ────────────────────────────────────────────────────────
  [EVENTS.ATTENDANCE_REQUESTED]: (d) => [{
    kind: 'attendance.request',
    app: 'hr',
    users: { permission: 'hr.attendance.approve' },
    title: `${d.employee_name} asked to correct attendance for ${shortDate(d.on_date)}`,
    body: d.reason ?? null,
    link: '/hr/attendance',
  }],

  [EVENTS.ATTENDANCE_DECIDED]: (d) => {
    const approved = d.decision === 'approved';
    const title = `Attendance for ${shortDate(d.on_date)} was ${approved ? 'approved' : 'rejected'}`;
    const out = [];
    // The employee, in their portal…
    if (d.employee_user_id) {
      out.push({
        kind: 'attendance.decided', app: 'hr', users: [d.employee_user_id],
        title, body: d.note ?? null, link: '/portal/attendance',
      });
    }
    // …and the HR clerk who raised it on their behalf, if that was someone else.
    if (d.requested_by && d.requested_by !== d.employee_user_id) {
      out.push({
        kind: 'attendance.decided', app: 'hr', users: [d.requested_by],
        title: `${d.employee_name}: ${title.toLowerCase()}`, body: d.note ?? null, link: '/hr/attendance',
      });
    }
    return out;
  },

  // ── leave ─────────────────────────────────────────────────────────────
  [EVENTS.LEAVE_REQUESTED]: (d) => [{
    kind: 'leave.request',
    app: 'hr',
    users: { permission: 'hr.leave.approve' },
    title: `${d.employee_name} requested ${d.leave_type ?? 'leave'}`,
    body: `${span(d.start_date, d.end_date)} · ${Number(d.days)} day${Number(d.days) === 1 ? '' : 's'}`,
    link: '/hr/leave',
  }],

  [EVENTS.LEAVE_APPROVED]: (d) => leaveDecided(d, true),
  [EVENTS.LEAVE_REJECTED]: (d) => leaveDecided(d, false),

  // ── documents and reviews ─────────────────────────────────────────────
  [EVENTS.DOCUMENT_ISSUED]: (d) => (d.employee_user_id ? [{
    kind: 'document.issued',
    app: 'hr',
    users: [d.employee_user_id],
    title: d.requires_acknowledgement
      ? `Please read and acknowledge: ${d.title}`
      : `New document: ${d.title}`,
    body: d.reference ?? null,
    link: '/portal/documents',
  }] : []),

  [EVENTS.REVIEW_OPENED]: (d) => [{
    kind: 'review.opened',
    app: 'hr',
    users: d.user_ids ?? [],
    title: `Your self-review for ${d.cycle_name} is open`,
    body: d.due ? `Due by ${shortDate(d.due)}` : null,
    link: '/portal/performance',
  }],

  [EVENTS.REVIEW_SHARED]: (d) => [{
    kind: 'review.shared',
    app: 'hr',
    users: d.user_ids ?? [],
    title: `Your ${d.cycle_name} review is ready to read`,
    body: null,
    link: '/portal/performance',
  }],

  // ── tasks ─────────────────────────────────────────────────────────────
  [EVENTS.TASK_ASSIGNED]: (d) => (d.assignee_id ? [{
    kind: 'task.assigned',
    app: 'tasks',
    users: [d.assignee_id],
    title: `Assigned to you: ${d.title}`,
    body: d.due_date ? `Due ${shortDate(d.due_date)}` : null,
    link: `/tasks?task=${d.task_id}`,
  }] : []),

  [EVENTS.BOARD_MEMBER_ADDED]: (d) => (d.user_id ? [{
    kind: 'board.member_added',
    app: 'tasks',
    users: [d.user_id],
    title: `You were added to the board “${d.name}”`,
    body: d.role === 'viewer' ? 'You can view its tasks.' : 'You can add and update its tasks.',
    link: `/tasks/board?project=${d.project_id}`,
  }] : []),

  [EVENTS.TASK_COMPLETED]: (d) => (d.created_by ? [{
    kind: 'task.completed',
    app: 'tasks',
    users: [d.created_by],
    title: `Done: ${d.title}`,
    body: null,
    link: `/tasks?task=${d.task_id}`,
  }] : []),
};

function leaveDecided(d, approved) {
  const title = `Your ${d.leave_type ?? 'leave'} for ${span(d.start_date, d.end_date)} was ${approved ? 'approved' : 'rejected'}`;
  const users = [...new Set([d.employee_user_id, d.requested_by].filter(Boolean))];
  return users.length ? [{
    kind: 'leave.decided', app: 'hr', users, title, body: d.note ?? null, link: '/portal/leave',
  }] : [];
}
