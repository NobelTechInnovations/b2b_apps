import { test } from 'node:test';
import assert from 'node:assert/strict';
import { API, workspace, invite, ok } from './helpers.js';

const APPS = ['helpdesk', 'knowledge', 'recruitment', 'hr', 'expenses', 'surveys', 'crm', 'tasks'];
const publicCall = async (path, method = 'GET', body) => {
  const response = await fetch(`${API}/api${path}`, {
    method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  return { status: response.status, ...(text && text.startsWith('{') ? JSON.parse(text) : { text }) };
};

test('Helpdesk and Knowledge Base', async (t) => {
  const { client: owner, stamp } = await workspace(APPS);
  const { client: other } = await workspace(['helpdesk']);
  const me = ok(await owner.call('/me/workspace')).user.id;
  const member = await invite(owner, 'member', `${stamp}-agent`);
  const guest = await invite(owner, 'guest', `${stamp}-guest`);
  let ticket;

  await t.test('a ticket gets a number and SLA clocks from its priority', async () => {
    ticket = ok(await owner.call('/helpdesk/tickets', 'POST', {
      subject: 'Visa document checklist missing', priority: 'urgent', channel: 'whatsapp',
      requester_name: 'Asif Khan', requester_phone: '+91 98765 43210', requester_email: 'asif@example.com',
    }), 201);
    assert.equal(ticket.number, 1);
    const hour = (new Date(ticket.first_response_due) - new Date(ticket.created_at)) / 60_000;
    assert.equal(hour, 60);
    assert.equal(ticket.sla_state, 'ok');
    assert.equal(ok(await owner.call('/helpdesk/tickets', 'POST', { subject: 'Second' }), 201).number, 2);
  });

  await t.test('assignment needs the permission and a member with access', async () => {
    const otherUser = ok(await other.call('/me/workspace')).user.id;
    assert.equal((await owner.call(`/helpdesk/tickets/${ticket.id}`, 'PATCH', { assignee_id: otherUser })).status, 400);
    assert.equal((await member.call(`/helpdesk/tickets/${ticket.id}`, 'PATCH', { assignee_id: me })).status, 403);
    ok(await owner.call(`/helpdesk/tickets/${ticket.id}`, 'PATCH', { assignee_id: me }));
    const agents = ok(await member.call('/helpdesk/agents'));
    assert.ok(agents.some((a) => a.user_id === me && a.name), 'agents are listed by name for the picker');
  });

  await t.test('a note does not stop the response clock; a reply does', async () => {
    ok(await owner.call(`/helpdesk/tickets/${ticket.id}/messages`, 'POST', { kind: 'note', body: 'Checked the file.' }), 201);
    assert.equal(ok(await owner.call(`/helpdesk/tickets/${ticket.id}`)).first_response_at, null);
    const replied = ok(await owner.call(`/helpdesk/tickets/${ticket.id}/messages`, 'POST', { kind: 'reply', body: 'Sent the checklist.', status: 'resolved' }), 201);
    assert.ok(replied.ticket.first_response_at);
    assert.equal(replied.ticket.status, 'resolved');
    assert.equal(replied.ticket.sla_state, 'met');
    const detail = ok(await owner.call(`/helpdesk/tickets/${ticket.id}`));
    assert.ok(detail.messages.some((m) => m.kind === 'event' && m.body.includes('Resolved')));
  });

  await t.test('a closed ticket takes no replies; guests only read; other workspaces see nothing', async () => {
    ok(await owner.call(`/helpdesk/tickets/${ticket.id}`, 'PATCH', { status: 'closed' }));
    assert.equal((await owner.call(`/helpdesk/tickets/${ticket.id}/messages`, 'POST', { kind: 'reply', body: 'x' })).status, 400);
    ok(await guest.call(`/helpdesk/tickets/${ticket.id}`));
    assert.equal((await guest.call('/helpdesk/tickets', 'POST', { subject: 'no' })).status, 403);
    assert.equal((await other.call(`/helpdesk/tickets/${ticket.id}`)).status, 404);
  });

  await t.test('SLA policy is editable and validated; overview counts', async () => {
    const policies = ok(await owner.call('/helpdesk/sla'));
    assert.equal(policies.length, 4);
    assert.equal((await owner.call('/helpdesk/sla', 'PUT', { policies: [{ priority: 'low', first_response_minutes: 600, resolution_minutes: 60 }] })).status, 400);
    ok(await owner.call('/helpdesk/sla', 'PUT', { policies: [{ priority: 'low', first_response_minutes: 120, resolution_minutes: 600 }] }));
    const overview = ok(await owner.call('/helpdesk/overview'));
    assert.equal(overview.active, 1);
    assert.equal(overview.unassigned, 1);
  });

  await t.test('a ticket can become a linked task', async () => {
    const task = ok(await owner.call('/tasks', 'POST', { title: 'Follow up on visa file', source_app: 'helpdesk', source_type: 'ticket', source_id: ticket.id }), 201);
    assert.equal(task.source_id, ticket.id);
  });

  await t.test('drafts are invisible to readers; publishing is its own permission', async () => {
    const category = ok(await owner.call('/knowledge/categories', 'POST', { name: 'Visa & travel' }), 201);
    const article = ok(await member.call('/knowledge/articles', 'POST', { title: 'Blocked account for Germany', body: 'A blocked account (Sperrkonto) proves funds for your student visa.', category_id: category.id }), 201);
    assert.equal(article.status, 'draft');
    assert.equal((await guest.call(`/knowledge/articles/${article.id}`)).status, 404);
    assert.equal(ok(await guest.call('/knowledge/articles')).length, 0);
    assert.equal((await member.call(`/knowledge/articles/${article.id}/status`, 'POST', { status: 'published' })).status, 403);
    ok(await owner.call(`/knowledge/articles/${article.id}/status`, 'POST', { status: 'published' }));
    ok(await guest.call(`/knowledge/articles/${article.id}`));
    const found = ok(await guest.call('/knowledge/articles?q=sperrk'));
    assert.equal(found[0]?.id, article.id, 'prefix search finds the article');
    assert.equal((await other.call(`/knowledge/articles/${article.id}`)).status, 403, 'another workspace without the app');
  });
});

test('Recruitment: pipeline, offer, hire into HR, careers page', async (t) => {
  const { client: owner, stamp } = await workspace(APPS);
  const me = ok(await owner.call('/me/workspace')).user.id;
  const slug = ok(await owner.call('/organizations/current')).slug;
  let job, candidate;

  await t.test('an open public job appears on the careers page', async () => {
    job = ok(await owner.call('/recruitment/jobs', 'POST', { title: 'German Language Trainer', status: 'open', openings: 1, location: 'Delhi' }), 201);
    ok(await owner.call('/recruitment/jobs', 'POST', { title: 'Draft role' }), 201);
    const page = await publicCall(`/careers/${slug}`);
    assert.equal(page.status, 200);
    assert.deepEqual(page.data.jobs.map((j) => j.title), ['German Language Trainer']);
    assert.equal((await publicCall('/careers/no-such-company-0000')).status, 404);
  });

  await t.test('applying is public, idempotent and bot-resistant', async () => {
    const application = { first_name: 'Priya', last_name: 'Sharma', email: `priya-${stamp}@example.com`, phone: '+91 90000 00000', experience_years: 3 };
    assert.equal((await publicCall(`/careers/${slug}/jobs/${job.id}/apply`, 'POST', application)).status, 201);
    assert.equal((await publicCall(`/careers/${slug}/jobs/${job.id}/apply`, 'POST', application)).status, 201);
    assert.equal((await publicCall(`/careers/${slug}/jobs/${job.id}/apply`, 'POST', { ...application, email: 'bot@example.com', website: 'http://spam' })).status, 201);
    const list = ok(await owner.call(`/recruitment/candidates?job_id=${job.id}`));
    assert.equal(list.length, 1, 'one applicant, no duplicate, no bot');
    candidate = list[0];
    assert.equal(candidate.stage, 'applied');
    assert.equal((await owner.call('/recruitment/candidates', 'POST', { job_id: job.id, first_name: 'Priya', email: application.email })).status, 409);
  });

  await t.test('stages move with reasons; interviews move people into the interview stage', async () => {
    assert.equal((await owner.call(`/recruitment/candidates/${candidate.id}/stage`, 'POST', { stage: 'rejected' })).status, 400);
    ok(await owner.call(`/recruitment/candidates/${candidate.id}/stage`, 'POST', { stage: 'screening' }));
    ok(await owner.call(`/recruitment/candidates/${candidate.id}/interviews`, 'POST', { scheduled_at: new Date(Date.now() + 86_400_000).toISOString(), interviewer_id: me, mode: 'video' }), 201);
    assert.ok(ok(await owner.call('/recruitment/people')).some((p) => p.user_id === me));
    const detail = ok(await owner.call(`/recruitment/candidates/${candidate.id}`));
    assert.equal(detail.stage, 'interview');
    assert.equal(detail.interviews.length, 1);
    const interview = detail.interviews[0];
    assert.equal((await owner.call(`/recruitment/interviews/${interview.id}`, 'PATCH', { status: 'completed' })).status, 400, 'feedback required');
    ok(await owner.call(`/recruitment/interviews/${interview.id}`, 'PATCH', { status: 'completed', rating: 4, recommendation: 'yes', feedback: 'Clear speaker, B2 level.' }));
  });

  await t.test('an offer must be approved before it is accepted, and before hiring', async () => {
    ok(await owner.call(`/recruitment/candidates/${candidate.id}/offer`, 'PUT', { ctc_annual: 420000, joining_on: '2026-11-02', status: 'proposed' }));
    assert.equal((await owner.call(`/recruitment/candidates/${candidate.id}/offer`, 'PUT', { status: 'accepted' })).status, 400);
    assert.equal((await owner.call(`/recruitment/candidates/${candidate.id}/hire`, 'POST', {})).status, 400);
    ok(await owner.call(`/recruitment/candidates/${candidate.id}/offer`, 'PUT', { status: 'approved' }));
    ok(await owner.call(`/recruitment/candidates/${candidate.id}/offer`, 'PUT', { status: 'accepted' }));
  });

  await t.test('hiring creates the employee and fills the opening', async () => {
    const hired = ok(await owner.call(`/recruitment/candidates/${candidate.id}/hire`, 'POST', { designation: 'German Trainer' }));
    const employee = ok(await owner.call(`/hr/employees/${hired.employee.id}`));
    assert.equal(employee.first_name, 'Priya');
    assert.equal(employee.designation, 'German Trainer');
    assert.equal(employee.joined_on, '2026-11-02');
    assert.equal((await owner.call(`/recruitment/candidates/${candidate.id}/hire`, 'POST', {})).status, 409);
    assert.equal((await owner.call(`/recruitment/candidates/${candidate.id}/stage`, 'POST', { stage: 'screening' })).status, 400);
    const jobs = ok(await owner.call('/recruitment/jobs'));
    assert.equal(jobs.find((j) => j.id === job.id).status, 'closed');
    assert.equal((await publicCall(`/careers/${slug}/jobs/${job.id}`)).status, 404, 'a filled job leaves the careers page');
  });
});

test('Expenses: own claims, receipts, limits, approval and reimbursement', async (t) => {
  const { client: owner, stamp } = await workspace(APPS);
  const asha = await invite(owner, 'employee', `${stamp}-asha`);
  const ravi = await invite(owner, 'employee', `${stamp}-ravi`);
  const categories = ok(await asha.call('/expenses/categories'));
  const food = categories.find((c) => c.name === 'Food & meals');
  const other = categories.find((c) => c.name === 'Other');
  let claim;

  await t.test('employees draft their own claims; receipts are enforced at submit', async () => {
    claim = ok(await asha.call('/expenses/claims', 'POST', { title: 'Student counselling trip, Jaipur' }), 201);
    assert.match(claim.number, /^EXP-\d{4}$/);
    const today = new Date().toISOString().slice(0, 10);
    const line = ok(await asha.call(`/expenses/claims/${claim.id}/lines`, 'POST', { spent_on: today, category_id: food.id, amount: 3500, merchant: 'Hotel' }), 201);
    ok(await asha.call(`/expenses/claims/${claim.id}/lines`, 'POST', { spent_on: today, category_id: other.id, amount: '250.50' }), 201);
    assert.equal(ok(await asha.call(`/expenses/claims/${claim.id}`)).total, '3750.50');
    const refused = await asha.call(`/expenses/claims/${claim.id}/submit`, 'POST', {});
    assert.equal(refused.status, 400);
    ok(await asha.call(`/expenses/claims/${claim.id}/lines/${line.id}`, 'PATCH', { receipt_url: 'https://example.com/receipt.jpg' }));
    const submitted = ok(await asha.call(`/expenses/claims/${claim.id}/submit`, 'POST', {}));
    assert.equal(submitted.status, 'submitted');
    assert.equal(submitted.policy_warnings[0]?.category, 'Food & meals', 'over the ₹3,000 monthly limit');
  });

  await t.test('nobody sees a colleague’s claim without approve rights; nobody decides their own', async () => {
    assert.equal((await ravi.call(`/expenses/claims/${claim.id}`)).status, 404);
    assert.equal((await ravi.call('/expenses/claims?scope=team')).status, 403);
    assert.equal(ok(await ravi.call('/expenses/claims')).length, 0);
    assert.equal((await asha.call(`/expenses/claims/${claim.id}/decision`, 'POST', { decision: 'approve' })).status, 403);
    assert.equal((await asha.call(`/expenses/claims/${claim.id}/lines`, 'POST', { spent_on: '2026-01-01', category_id: other.id, amount: 10 })).status, 400, 'submitted claims are locked');
  });

  await t.test('approve with a reason to reject; reimburse only approved claims', async () => {
    const team = ok(await owner.call('/expenses/claims?scope=team'));
    assert.ok(team.find((c) => c.id === claim.id)?.claimant_name, 'approvers see whose claim it is');
    assert.equal((await owner.call(`/expenses/claims/${claim.id}/reimburse`, 'POST', {})).status, 400);
    assert.equal((await owner.call(`/expenses/claims/${claim.id}/decision`, 'POST', { decision: 'reject' })).status, 400);
    ok(await owner.call(`/expenses/claims/${claim.id}/decision`, 'POST', { decision: 'approve', note: 'OK for the student fair.' }));
    ok(await owner.call(`/expenses/claims/${claim.id}/reimburse`, 'POST', { reference: 'UPI 4321' }));
    const mine = ok(await asha.call(`/expenses/claims/${claim.id}`));
    assert.equal(mine.status, 'reimbursed');
    assert.equal(mine.payment_reference, 'UPI 4321');
  });
});

test('Surveys & Forms: public submissions become CRM leads', async (t) => {
  const { client: owner, stamp } = await workspace(APPS);
  let form;
  const email = `enquiry-${stamp}@example.com`;

  await t.test('a draft form is not public; a published one is', async () => {
    form = ok(await owner.call('/surveys/forms', 'POST', { name: 'Study in Germany enquiry', create_lead: true, lead_source: 'website' }), 201);
    assert.equal(form.fields.length, 4);
    assert.equal((await publicCall(`/public-forms/${form.public_token}`)).status, 404);
    ok(await owner.call(`/surveys/forms/${form.id}`, 'PATCH', { status: 'published' }));
    const view = await publicCall(`/public-forms/${form.public_token}`);
    assert.equal(view.status, 200);
    assert.equal(view.data.open, true);
  });

  await t.test('answers are validated field by field', async () => {
    const bad = await publicCall(`/public-forms/${form.public_token}/submit`, 'POST', { answers: { full_name: '', email: 'not-an-email' } });
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.error.details.map((d) => d.field).sort(), ['email', 'full_name']);
  });

  await t.test('a submission creates one lead; the same person again joins it', async () => {
    const first = await publicCall(`/public-forms/${form.public_token}/submit`, 'POST', { answers: { full_name: 'Neha Verma', email, phone: '+91 91111 22222', message: '=HYPERLINK("x") Masters in Munich' } });
    assert.equal(first.status, 201);
    assert.equal((await publicCall(`/public-forms/${form.public_token}/submit`, 'POST', { answers: { full_name: 'Neha Verma', email, message: 'Also IELTS?' } })).status, 201);
    const leads = ok(await owner.call(`/crm/leads?q=${encodeURIComponent(email)}`));
    assert.equal(leads.length, 1);
    assert.equal(leads[0].first_name, 'Neha');
    assert.equal(leads[0].source, 'website');
    const responses = await owner.call(`/surveys/forms/${form.id}/responses`);
    assert.equal(responses.meta.total, 2);
    assert.ok(responses.data.every((r) => r.lead_id === leads[0].id));
  });

  await t.test('CSV export neutralises formulas; closed forms refuse submissions', async () => {
    const response = await fetch(`${API}/api/surveys/forms/${form.id}/responses.csv`, { headers: { cookie: owner.cookie() } });
    const csv = await response.text();
    assert.ok(csv.includes(`"'=HYPERLINK`), 'formula-looking answers are prefixed');
    ok(await owner.call(`/surveys/forms/${form.id}`, 'PATCH', { status: 'closed' }));
    assert.equal((await publicCall(`/public-forms/${form.public_token}/submit`, 'POST', { answers: { full_name: 'Late', email: 'late@example.com' } })).status, 400);
  });
});
