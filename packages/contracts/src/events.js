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
