import { isKnownEvent } from '@nexus/contracts/events';

// Keep identifiers and event metadata, never raw payloads: event bodies can
// contain salary, medical leave details, addresses or credentials.
const RESOURCES = ['task_id', 'project_id', 'lead_id', 'deal_id', 'customer_id',
  'employee_id', 'leave_id', 'request_id', 'document_id', 'cycle_id', 'run_id',
  'subscription_id', 'invoice_id', 'member_id', 'role_id', 'app_slug'];
export async function recordEvent(db, event) {
  if (!event.org_id || !isKnownEvent(event.type)) return;
  if (!event.id || !event.occurred_at) throw new Error('Audit event is missing its identity or timestamp');
  const data = event.data ?? {};
  const resource = RESOURCES.map(key => data[key]).find(value => typeof value === 'string');
  await db.query(`INSERT INTO audit_events(event_id,org_id,actor_id,event_type,resource_id,occurred_at)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(event_id) DO NOTHING`,
  [event.id, event.org_id, event.actor_id ?? null, event.type, resource?.slice(0, 200) ?? null, event.occurred_at]);
}
