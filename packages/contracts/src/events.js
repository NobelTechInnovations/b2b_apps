/**
 * The event catalogue. Producers and consumers both import from here, so a
 * renamed event breaks at build time rather than silently in production.
 *
 * Subject convention:  nexus.<app>.<resource>.<action>
 */
export const EVENTS = {
  // ── identity ────────────────────────────────────────────────────────────
  USER_REGISTERED: 'identity.user.registered',
  USER_VERIFIED: 'identity.user.verified',
  USER_LOGGED_IN: 'identity.user.logged_in',
  USER_PASSWORD_CHANGED: 'identity.user.password_changed',
  SESSION_REVOKED: 'identity.session.revoked',

  // ── tenancy ─────────────────────────────────────────────────────────────
  ORG_CREATED: 'tenancy.org.created',
  ORG_UPDATED: 'tenancy.org.updated',
  MEMBER_INVITED: 'tenancy.member.invited',
  MEMBER_JOINED: 'tenancy.member.joined',
  MEMBER_ROLE_CHANGED: 'tenancy.member.role_changed',
  MEMBER_REMOVED: 'tenancy.member.removed',
  ROLE_UPDATED: 'tenancy.role.updated',

  // ── catalog ─────────────────────────────────────────────────────────────
  APP_INSTALLED: 'catalog.app.installed',
  APP_UNINSTALLED: 'catalog.app.uninstalled',
  APP_SUSPENDED: 'catalog.app.suspended',

  // ── billing ─────────────────────────────────────────────────────────────
  SUBSCRIPTION_CREATED: 'billing.subscription.created',
  SUBSCRIPTION_UPDATED: 'billing.subscription.updated',
  SUBSCRIPTION_CANCELED: 'billing.subscription.canceled',
  TRIAL_ENDING: 'billing.subscription.trial_ending',
  ENTITLEMENTS_CHANGED: 'billing.entitlements.changed',
  INVOICE_ISSUED: 'billing.invoice.issued',
  INVOICE_PAID: 'billing.invoice.paid',
  INVOICE_OVERDUE: 'billing.invoice.overdue',

  // ── crm ─────────────────────────────────────────────────────────────────
  LEAD_CREATED: 'crm.lead.created',
  LEAD_CONVERTED: 'crm.lead.converted',
  DEAL_CREATED: 'crm.deal.created',
  DEAL_STAGE_CHANGED: 'crm.deal.stage_changed',
  DEAL_WON: 'crm.deal.won',
  DEAL_LOST: 'crm.deal.lost',
  CUSTOMER_CREATED: 'crm.customer.created',
  CUSTOMER_UPDATED: 'crm.customer.updated',

  // ── hr ──────────────────────────────────────────────────────────────────
  EMPLOYEE_CREATED: 'hr.employee.created',
  EMPLOYEE_UPDATED: 'hr.employee.updated',
  EMPLOYEE_OFFBOARDED: 'hr.employee.offboarded',
  LEAVE_REQUESTED: 'hr.leave.requested',
  LEAVE_APPROVED: 'hr.leave.approved',
  LEAVE_REJECTED: 'hr.leave.rejected',
  ATTENDANCE_REQUESTED: 'hr.attendance.requested',
  ATTENDANCE_DECIDED: 'hr.attendance.decided',
  DOCUMENT_ISSUED: 'hr.document.issued',
  REVIEW_OPENED: 'hr.review.opened',
  REVIEW_SHARED: 'hr.review.shared',

  // ── payroll ─────────────────────────────────────────────────────────────
  PAYROLL_PROCESSED: 'payroll.run.processed',
  PAYROLL_APPROVED: 'payroll.run.approved',
  PAYROLL_PAID: 'payroll.run.paid',
  PAYROLL_CANCELLED: 'payroll.run.cancelled',
  SALARY_REVISED: 'payroll.salary.revised',

  // ── tasks ───────────────────────────────────────────────────────────────
  TASK_CREATED: 'tasks.task.created',
  TASK_ASSIGNED: 'tasks.task.assigned',
  TASK_COMPLETED: 'tasks.task.completed',
  BOARD_MEMBER_ADDED: 'tasks.board.member_added',

  // ── helpdesk & knowledge ────────────────────────────────────────────────
  TICKET_CREATED: 'helpdesk.ticket.created',
  TICKET_ASSIGNED: 'helpdesk.ticket.assigned',
  TICKET_REPLIED: 'helpdesk.ticket.replied',
  TICKET_RESOLVED: 'helpdesk.ticket.resolved',
  ARTICLE_PUBLISHED: 'knowledge.article.published',

  // ── recruitment ─────────────────────────────────────────────────────────
  CANDIDATE_APPLIED: 'recruitment.candidate.applied',
  CANDIDATE_STAGE_CHANGED: 'recruitment.candidate.stage_changed',
  INTERVIEW_SCHEDULED: 'recruitment.interview.scheduled',
  CANDIDATE_HIRED: 'recruitment.candidate.hired',

  // ── expenses ────────────────────────────────────────────────────────────
  EXPENSE_SUBMITTED: 'expenses.claim.submitted',
  EXPENSE_APPROVED: 'expenses.claim.approved',
  EXPENSE_REJECTED: 'expenses.claim.rejected',
  EXPENSE_REIMBURSED: 'expenses.claim.reimbursed',

  // ── surveys & forms ─────────────────────────────────────────────────────
  FORM_SUBMITTED: 'surveys.form.submitted',

  // ── operations: inventory, manufacturing, quality, maintenance ──────────
  PURCHASE_RECEIVED: 'erp.purchase.received',
  STOCK_LOW: 'erp.stock.low',
  MO_COMPLETED: 'manufacturing.order.completed',
  QUALITY_CHECK_FAILED: 'quality.check.failed',
  NCR_RAISED: 'quality.ncr.raised',
  MAINTENANCE_REQUESTED: 'maintenance.request.created',

  // ── commerce ────────────────────────────────────────────────────────────
  POS_SALE_COMPLETED: 'pos.sale.completed',
  POS_SALE_REFUNDED: 'pos.sale.refunded',
  STORE_ORDER_PLACED: 'ecommerce.order.placed',
  STORE_ORDER_DELIVERED: 'ecommerce.order.delivered',
  STORE_ORDER_CANCELLED: 'ecommerce.order.cancelled',
  SUBSCRIPTION_STARTED: 'recurring.subscription.started',
  SUBSCRIPTION_CANCELLED: 'recurring.subscription.cancelled',

  // ── finance ─────────────────────────────────────────────────────────────
  PAYMENT_RECEIVED: 'billing.payment.received',
  JOURNAL_POSTED: 'accounting.journal.posted',
  ASSET_DEPRECIATED: 'assets.depreciation.posted',

  // ── sales & marketing ───────────────────────────────────────────────────
  QUOTE_APPROVAL_REQUESTED: 'quotes.quotation.approval_requested',
  QUOTE_SENT: 'quotes.quotation.sent',
  QUOTE_ACCEPTED: 'quotes.quotation.accepted',
  QUOTE_DECLINED: 'quotes.quotation.declined',
  ORDER_CONFIRMED: 'quotes.order.confirmed',
  PARTNER_DEAL_REGISTERED: 'partners.deal.registered',
  PARTNER_DEAL_APPROVED: 'partners.deal.approved',
  CAMPAIGN_SENT: 'marketing.campaign.sent',
  SOCIAL_POST_DUE: 'social.post.due',

  // ── service ─────────────────────────────────────────────────────────────
  FIELD_JOB_ASSIGNED: 'fieldservice.job.assigned',
  FIELD_JOB_COMPLETED: 'fieldservice.job.completed',

  // ── people ──────────────────────────────────────────────────────────────
  COURSE_ASSIGNED: 'learning.course.assigned',
  COURSE_COMPLETED: 'learning.course.completed',
  DEVICE_ASSIGNED: 'devices.device.assigned',
  DEVICE_RETURN_REQUESTED: 'devices.device.return_requested',

  // ── collaboration & legal ───────────────────────────────────────────────
  DISCUSS_MENTIONED: 'discuss.message.mentioned',
  MEETING_INVITED: 'meetings.event.invited',
  MEETING_BOOKED: 'meetings.booking.created',
  ENVELOPE_SENT: 'sign.envelope.sent',
  ENVELOPE_SIGNED: 'sign.envelope.signed',
  ENVELOPE_COMPLETED: 'sign.envelope.completed',
  CONTRACT_APPROVAL_REQUESTED: 'contracts.contract.approval_requested',
  CONTRACT_APPROVED: 'contracts.contract.approved',
  CONTRACT_EXPIRING: 'contracts.contract.expiring',
  CONTROL_EVIDENCE_DUE: 'compliance.control.due',

  // ── platform ────────────────────────────────────────────────────────────
  FILE_UPLOADED: 'files.file.uploaded',
  NOTIFICATION_REQUESTED: 'notifier.notification.requested',
};

const KNOWN = new Set(Object.values(EVENTS));
export const isKnownEvent = (type) => KNOWN.has(type);

/**
 * Every event on the bus has this shape. `org_id` is mandatory for business
 * events so consumers can never process an event without a tenant.
 */
export function envelope({ id, type, orgId, actorId, data, version = 1, occurredAt }) {
  if (!isKnownEvent(type)) {
    throw new Error(`unknown event type "${type}" — add it to @nexus/contracts/events`);
  }
  return {
    id,
    type,
    version,
    org_id: orgId ?? null,
    actor_id: actorId ?? null,
    occurred_at: occurredAt ?? new Date().toISOString(),
    data: data ?? {},
  };
}
