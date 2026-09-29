#!/usr/bin/env node
/**
 * CRM end-to-end check.
 *
 * Runs the real sales motion through the public gateway: capture a lead, work
 * it, convert it into a company + contact + deal, move that deal across the
 * board, and confirm winning it turns the company into a customer.
 */
const GATEWAY = process.env.API_URL ?? 'http://localhost:4000';

let cookies = '';
let failures = 0;

const c = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

async function call(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${GATEWAY}/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', cookie: cookies },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';');
    const [name] = pair.split('=');
    cookies = [...cookies.split('; ').filter((x) => x && !x.startsWith(`${name}=`)), pair].join('; ');
  }
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

function check(label, condition, detail) {
  if (condition) console.log(`  ${c.ok('✔')} ${label}`);
  else {
    failures += 1;
    console.log(`  ${c.bad('✘')} ${label}${detail ? c.dim(`  → ${detail}`) : ''}`);
  }
  return condition;
}

const step = (n, label) => console.log(`\n${c.bold(`${n}. ${label}`)}`);

async function main() {
  const stamp = Date.now();
  console.log(c.bold('\n  CRM smoke test\n'));

  // ── setup: a workspace with CRM ──────────────────────────────────────────
  step(0, 'Workspace with CRM installed');
  const reg = await call('/auth/register', {
    method: 'POST',
    body: { email: `crm+${stamp}@nexus.test`, password: 'correct-horse-battery-7', name: 'CRM Tester' },
  });
  check('registered', reg.status === 201, `status ${reg.status}`);

  const org = await call('/organizations', {
    method: 'POST',
    body: { name: `Northwind ${stamp}`, industry: 'Software & IT', size_band: '11-50' },
  });
  check('workspace created', org.status === 201);

  await call('/auth/refresh', { method: 'POST', body: {} });

  const sub = await call('/subscriptions', {
    method: 'POST',
    body: { plan: 'business', app_slugs: ['crm'], seats: 10, cycle: 'monthly' },
  });
  check('subscribed to CRM', sub.status === 201, `status ${sub.status}`);
  await new Promise((r) => setTimeout(r, 1500));

  // ── 1 ── the board exists without configuration ─────────────────────────
  step(1, 'Pipeline is ready out of the box');
  const board = await call('/crm/pipeline');
  check('board loads', board.status === 200, `status ${board.status}`);
  check('default stages seeded', (board.body?.data?.columns?.length ?? 0) === 7,
    board.body?.data?.columns?.map((s) => s.name).join(' → '));
  check('has a won stage', board.body?.data?.columns?.some((s) => s.kind === 'won'));

  // ── 2 ── capture a lead ─────────────────────────────────────────────────
  step(2, 'Capture and work a lead');
  const lead = await call('/crm/leads', {
    method: 'POST',
    body: {
      first_name: 'Priya', last_name: 'Nair', company_name: 'Kestrel Systems',
      email: 'priya@kestrelsystems.in', phone: '+91 98200 11223',
      job_title: 'Head of Ops', source: 'website', rating: 'hot',
      estimated_value: '450000.00',
    },
  });
  check('lead created', lead.status === 201, `status ${lead.status}`);
  const leadId = lead.body?.data?.id;
  check('lead scored from completeness', lead.body?.data?.score >= 80,
    `score ${lead.body?.data?.score}`);

  const logged = await call('/crm/activities', {
    method: 'POST',
    body: { kind: 'call', subject: 'Intro call', related_type: 'lead', related_id: leadId, completed: true },
  });
  check('activity logged against lead', logged.status === 201);

  const afterCall = await call(`/crm/leads/${leadId}`);
  check('logging a call advances the lead', afterCall.body?.data?.status === 'contacted',
    `status ${afterCall.body?.data?.status}`);

  // ── 3 ── convert ────────────────────────────────────────────────────────
  step(3, 'Convert the lead');
  const converted = await call(`/crm/leads/${leadId}/convert`, {
    method: 'POST',
    body: { create_deal: true, deal_title: 'Kestrel — platform rollout', deal_value: '450000.00' },
  });
  check('conversion succeeded', converted.status === 200, `status ${converted.status}`);
  const { company_id: companyId, contact_id: contactId, deal_id: dealId } = converted.body?.data ?? {};
  check('company created', Boolean(companyId));
  check('contact created', Boolean(contactId));
  check('deal created', Boolean(dealId));

  const reconvert = await call(`/crm/leads/${leadId}/convert`, { method: 'POST', body: {} });
  check('converting twice is refused', reconvert.status === 400, `status ${reconvert.status}`);

  const timeline = await call(`/crm/contacts/${contactId}`);
  check('lead history moved onto the contact',
    (timeline.body?.data?.activities?.length ?? 0) > 0,
    `${timeline.body?.data?.activities?.length ?? 0} activities`);

  // ── 4 ── work the board ─────────────────────────────────────────────────
  step(4, 'Move the deal across the board');
  const stages = (await call('/crm/pipeline')).body?.data?.columns ?? [];
  const demo = stages.find((s) => s.name === 'Demo');
  const wonStage = stages.find((s) => s.kind === 'won');

  const moved = await call(`/crm/deals/${dealId}/move`, {
    method: 'POST',
    body: { stage_id: demo.id },
  });
  check('deal moved to Demo', moved.status === 200, `status ${moved.status}`);
  check('probability follows the stage', moved.body?.data?.probability === demo.probability,
    `${moved.body?.data?.probability}%`);

  const detail = await call(`/crm/deals/${dealId}`);
  check('stage change recorded in history',
    (detail.body?.data?.stage_history?.length ?? 0) >= 2,
    `${detail.body?.data?.stage_history?.length ?? 0} entries`);

  // ── 5 ── win it ─────────────────────────────────────────────────────────
  step(5, 'Win the deal');
  const won = await call(`/crm/deals/${dealId}/move`, {
    method: 'POST',
    body: { stage_id: wonStage.id },
  });
  check('deal marked won', won.body?.data?.status === 'won', won.body?.data?.status);
  check('closed_at stamped', Boolean(won.body?.data?.closed_at));

  const company = await call(`/crm/companies/${companyId}`);
  check('winning turns the company into a customer',
    company.body?.data?.is_customer === true);
  check('customer_since stamped', Boolean(company.body?.data?.customer_since));

  // ── 6 ── the numbers add up ─────────────────────────────────────────────
  step(6, 'Overview reflects reality');
  const overview = await call('/crm/overview');
  check('overview loads', overview.status === 200);
  check('won revenue counted this month',
    Number(overview.body?.data?.pipeline?.won_this_month) === 450000,
    `₹${overview.body?.data?.pipeline?.won_this_month}`);
  check('conversion rate computed',
    overview.body?.data?.leads?.conversion_rate === 100,
    `${overview.body?.data?.leads?.conversion_rate}%`);

  const widgets = await call('/crm/widgets');
  check('dashboard widgets served', widgets.status === 200 &&
    widgets.body?.data?.['crm.deals_won'] !== undefined);

  // ── 7 ── guards ─────────────────────────────────────────────────────────
  step(7, 'Guard rails');
  const orphan = await call('/crm/activities', {
    method: 'POST',
    body: { kind: 'note', subject: 'nope', related_type: 'deal', related_id: 'dea_00000000000000000000000000' },
  });
  check('cannot attach activity to a non-existent record', orphan.status === 404,
    `status ${orphan.status}`);

  const badCompany = await call('/crm/companies', { method: 'POST', body: { name: '' } });
  check('empty company name rejected', badCompany.status === 400, `status ${badCompany.status}`);

  // A second workspace must not see the first one's data.
  await call('/auth/logout', { method: 'POST' });
  cookies = '';
  await call('/auth/register', {
    method: 'POST',
    body: { email: `other+${stamp}@nexus.test`, password: 'correct-horse-battery-7', name: 'Other Co' },
  });
  await call('/organizations', { method: 'POST', body: { name: `Other ${stamp}` } });
  await call('/auth/refresh', { method: 'POST', body: {} });
  await call('/subscriptions', {
    method: 'POST',
    body: { plan: 'business', app_slugs: ['crm'], seats: 5, cycle: 'monthly' },
  });
  await new Promise((r) => setTimeout(r, 1200));

  const leakList = await call('/crm/leads');
  check('a new workspace sees no other tenant’s leads',
    (leakList.body?.data?.length ?? -1) === 0,
    `${leakList.body?.data?.length} leads visible`);

  const leakRead = await call(`/crm/deals/${dealId}`);
  check('cannot read another tenant’s deal by id', leakRead.status === 404,
    `status ${leakRead.status}`);

  console.log('');
  if (failures === 0) {
    console.log(c.ok(c.bold('  ✔ everything passed\n')));
    process.exit(0);
  }
  console.log(c.bad(c.bold(`  ✘ ${failures} check${failures === 1 ? '' : 's'} failed\n`)));
  process.exit(1);
}

main().catch((error) => {
  console.error(`\n  ${c.bad('crm smoke crashed:')} ${error.stack}\n`);
  process.exit(1);
});
