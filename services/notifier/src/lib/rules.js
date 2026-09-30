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

  // ── helpdesk ──────────────────────────────────────────────────────────
  // An unassigned ticket goes to whoever hands tickets out; an assigned one
  // straight to its owner.
  [EVENTS.TICKET_CREATED]: (d) => (d.assignee_id ? [] : [{
    kind: 'ticket.created', app: 'helpdesk', users: { permission: 'helpdesk.tickets.assign' },
    title: `New ticket #${d.number}: ${d.subject}`, body: d.priority === 'urgent' ? 'Urgent' : null,
    link: `/helpdesk/tickets?ticket=${d.ticket_id}`,
  }]),
  [EVENTS.TICKET_ASSIGNED]: (d) => (d.assignee_id ? [{
    kind: 'ticket.assigned', app: 'helpdesk', users: [d.assignee_id],
    title: `Ticket #${d.number} assigned to you`, body: d.subject,
    link: `/helpdesk/tickets?ticket=${d.ticket_id}`,
  }] : []),
  [EVENTS.TICKET_REPLIED]: (d) => (d.assignee_id ? [{
    kind: 'ticket.replied', app: 'helpdesk', users: [d.assignee_id],
    title: `${d.kind === 'note' ? 'Note' : 'Reply'} on ticket #${d.number}`, body: d.subject,
    link: `/helpdesk/tickets?ticket=${d.ticket_id}`,
  }] : []),
  [EVENTS.TICKET_RESOLVED]: (d) => (d.created_by ? [{
    kind: 'ticket.resolved', app: 'helpdesk', users: [d.created_by],
    title: `Resolved: #${d.number} ${d.subject}`, body: null,
    link: `/helpdesk/tickets?ticket=${d.ticket_id}`,
  }] : []),

  // ── recruitment ───────────────────────────────────────────────────────
  [EVENTS.CANDIDATE_APPLIED]: (d) => [{
    kind: 'candidate.applied', app: 'recruitment',
    users: d.hiring_manager_id ? [d.hiring_manager_id] : { permission: 'recruitment.candidates.advance' },
    title: `New applicant for ${d.job_title}: ${d.name}`,
    body: d.source === 'careers_page' ? 'Applied through the careers page' : null,
    link: `/recruitment?candidate=${d.candidate_id}`,
  }],
  [EVENTS.INTERVIEW_SCHEDULED]: (d) => [{
    kind: 'interview.scheduled', app: 'recruitment', users: [d.interviewer_id],
    title: `Interview with ${d.name} (${d.job_title})`, body: shortDate(d.scheduled_at),
    link: `/recruitment/interviews`,
  }],
  [EVENTS.CANDIDATE_STAGE_CHANGED]: (d) => (d.owner_id ? [{
    kind: 'candidate.stage', app: 'recruitment', users: [d.owner_id],
    title: `${d.name} moved to ${d.to}`, body: d.job_title,
    link: `/recruitment?candidate=${d.candidate_id}`,
  }] : []),

  // ── expenses ──────────────────────────────────────────────────────────
  [EVENTS.EXPENSE_SUBMITTED]: (d) => [{
    kind: 'expense.submitted', app: 'expenses', users: { permission: 'expenses.claims.approve' },
    title: `Expense claim ${d.number} to approve: ₹${d.total}`, body: d.title,
    link: `/expenses/approvals?claim=${d.claim_id}`,
  }],
  [EVENTS.EXPENSE_APPROVED]: (d) => [{
    kind: 'expense.decided', app: 'expenses', users: [d.user_id],
    title: `Your claim ${d.number} was approved`, body: `₹${d.total} · ${d.title}`,
    link: `/expenses?claim=${d.claim_id}`,
  }],
  [EVENTS.EXPENSE_REJECTED]: (d) => [{
    kind: 'expense.decided', app: 'expenses', users: [d.user_id],
    title: `Your claim ${d.number} was rejected`, body: d.note ?? d.title,
    link: `/expenses?claim=${d.claim_id}`,
  }],
  [EVENTS.EXPENSE_REIMBURSED]: (d) => [{
    kind: 'expense.reimbursed', app: 'expenses', users: [d.user_id],
    title: `₹${d.total} reimbursed for ${d.number}`, body: d.title,
    link: `/expenses?claim=${d.claim_id}`,
  }],

  // ── forms ─────────────────────────────────────────────────────────────
  [EVENTS.FORM_SUBMITTED]: (d) => [{
    kind: 'form.submitted', app: 'surveys', users: [...new Set([d.created_by, d.lead_owner_id].filter(Boolean))],
    title: `New response to ${d.form_name}`, body: d.contact_name ? `From ${d.contact_name}${d.lead_id ? ' · added to CRM leads' : ''}` : null,
    link: `/surveys?form=${d.form_id}`,
  }],

  // ── operations ────────────────────────────────────────────────────────
  [EVENTS.STOCK_LOW]: (d) => [{
    kind: 'erp.stock_low', app: 'erp', users: { permission: 'erp.purchase.create' },
    title: `Low stock: ${d.name}`, body: `${Number(d.on_hand).toLocaleString('en-IN')} left (reorder at ${Number(d.reorder_level).toLocaleString('en-IN')})`,
    link: `/erp/products?open=${d.product_id}`,
  }],
  [EVENTS.PURCHASE_RECEIVED]: (d) => [{
    kind: 'erp.received', app: 'erp', users: { permission: 'erp.purchase.approve' },
    title: `${d.complete ? 'Received' : 'Part received'}: ${d.number} from ${d.vendor_name}`, body: `₹${d.value}`,
    link: `/erp/purchase?order=${d.po_id}`,
  }],
  [EVENTS.QUALITY_CHECK_FAILED]: (d) => [{
    kind: 'quality.failed', app: 'quality', users: { permission: 'quality.ncr.close' },
    title: `${d.number} failed: ${d.product_name ?? 'product'}`, body: d.failed?.join(', ') ?? null,
    link: `/quality?check=${d.check_id}`,
  }],
  [EVENTS.NCR_RAISED]: (d) => [{
    kind: 'quality.ncr', app: 'quality', users: d.owner_id ? [d.owner_id] : { permission: 'quality.ncr.close' },
    title: `${d.severity === 'critical' ? 'Critical ' : ''}non-conformance ${d.number}`, body: d.title,
    link: `/quality/ncr?open=${d.ncr_id}`,
  }],
  [EVENTS.MAINTENANCE_REQUESTED]: (d) => [{
    kind: 'maintenance.request', app: 'maintenance', users: d.assignee_id ? [d.assignee_id] : { permission: 'maintenance.requests.close' },
    title: `${d.priority === 'urgent' ? 'Urgent: ' : ''}${d.equipment_name} — ${d.title}`, body: d.number,
    link: `/maintenance/requests?open=${d.request_id}`,
  }],
  [EVENTS.STORE_ORDER_PLACED]: (d) => [{
    kind: 'ecommerce.order', app: 'ecommerce', users: { permission: 'ecommerce.orders.edit' },
    title: `New online order ${d.number}: ₹${d.total}`, body: d.customer_name,
    link: `/ecommerce/orders?order=${d.order_id}`,
  }],

  // ── sales & marketing ─────────────────────────────────────────────────
  [EVENTS.QUOTE_APPROVAL_REQUESTED]: (d) => [{
    kind: 'quotes.approval', app: 'quotes', users: { permission: 'quotes.quotations.approve' },
    title: `Approve quote ${d.number}: ${d.max_discount}% discount`, body: `${d.customer_name} · ₹${d.total}`,
    link: `/quotes?open=${d.quotation_id}`,
  }],
  [EVENTS.QUOTE_ACCEPTED]: (d) => (d.owner_user_id ? [{
    kind: 'quotes.accepted', app: 'quotes', users: [d.owner_user_id],
    title: `${d.customer_name} accepted quote ${d.number}`, body: `₹${d.total} · signed by ${d.accepted_by}`,
    link: `/quotes?open=${d.quotation_id}`,
  }] : []),
  [EVENTS.QUOTE_DECLINED]: (d) => (d.owner_user_id ? [{
    kind: 'quotes.declined', app: 'quotes', users: [d.owner_user_id],
    title: `${d.customer_name} declined quote ${d.number}`, body: d.reason ?? null,
    link: `/quotes?open=${d.quotation_id}`,
  }] : []),
  [EVENTS.PARTNER_DEAL_REGISTERED]: (d) => [{
    kind: 'partners.deal', app: 'partners', users: { permission: 'partners.deals.approve' },
    title: `${d.partner_name} registered ${d.customer_company}`, body: `${d.number} · ₹${d.expected_value}`,
    link: `/partners/deals?open=${d.partner_deal_id}`,
  }],
  [EVENTS.SOCIAL_POST_DUE]: (d) => [{
    kind: 'social.due', app: 'social', users: [...new Set([d.created_by, d.approved_by].filter(Boolean))],
    title: 'A scheduled post is due — publish it now', body: d.preview,
    link: `/social?open=${d.post_id}`,
  }],

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
