// Creates a fresh, disposable local review workspace through the public API.
import { session, ok } from './lib/api-client.js';
const target = process.env.API_URL ?? 'http://localhost:4000';
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(target).hostname)) throw new Error('Demo seeding is restricted to localhost.');
const client = session();
const email = `review-${Date.now()}@nexus.test`, password = 'Nexus-review-2026!';
ok(await client.call('/auth/register', 'POST', { email, password, name: 'Nexus Reviewer' }), 201);
ok(await client.call('/organizations', 'POST', { name: 'Nexus Review Workspace', industry: 'Services', size_band: '11-50' }), 201);
ok(await client.call('/auth/refresh', 'POST', {}));
ok(await client.call('/subscriptions', 'POST', { plan: 'business', app_slugs: ['crm', 'hr', 'payroll', 'documents', 'invoicing', 'tasks'], seats: 25, cycle: 'monthly' }), 201);
const me = ok(await client.call('/me/workspace')).user.id;
const project = ok(await client.call('/tasks/projects', 'POST', { name: 'Launch customer workspace', description: 'Review the connected sales, people and project workflows.', due_date: '2026-10-15' }), 201);
const milestone = ok(await client.call(`/tasks/projects/${project.id}/milestones`, 'POST', { title: 'Pilot ready', due_date: '2026-10-01' }), 201);
for (const [title, status, priority, due_date] of [
  ['Confirm customer requirements', 'done', 'high', '2026-09-23'],
  ['Configure team workspace', 'in_progress', 'high', '2026-09-25'],
  ['Review imported customer list', 'todo', 'medium', '2026-09-28'],
  ['Approve pilot launch', 'blocked', 'urgent', '2026-10-01'],
]) ok(await client.call('/tasks', 'POST', { title, status, priority, due_date, project_id: project.id, milestone_id: milestone.id, assignee_id: me }), 201);
const lead = ok(await client.call('/crm/leads', 'POST', { first_name: 'Aarav', last_name: 'Demo', company_name: 'Sample Industries', email: 'demo.customer@nexus.test' }), 201);
ok(await client.call('/tasks', 'POST', { title: 'Follow up with Sample Industries', source_app: 'crm', source_type: 'lead', source_id: lead.id, assignee_id: me, due_date: '2026-09-26' }), 201);
ok(await client.call('/hr/employees', 'POST', { first_name: 'Priya', last_name: 'Demo', email: 'demo.employee@nexus.test', designation: 'Project coordinator' }), 201);
console.log(JSON.stringify({ url: 'http://localhost:3000/tasks/board', email, password, project_id: project.id }, null, 2));
