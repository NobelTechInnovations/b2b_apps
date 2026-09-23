#!/usr/bin/env node
/**
 * The employee portal, end to end.
 *
 * An employee is invited, accepts, signs in, and sees their own attendance,
 * leave, payslips, documents and review — and nothing else. The security
 * assertions matter more than the feature ones: most of this suite exists to
 * prove that a portal login cannot reach a colleague's record, cannot reach
 * the workspace, and cannot see a payslip before it is approved.
 */
const GATEWAY = process.env.API_URL ?? 'http://localhost:4000';

let failures = 0;

const c = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

/**
 * Two signed-in identities at once — the HR admin and the employee — so the
 * isolation checks are a real second session rather than the same cookie jar
 * with a different intent.
 */
function session() {
  let cookies = '';

  function absorb(response) {
    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const [name] = pair.split('=');
      cookies = [...cookies.split('; ').filter((x) => x && !x.startsWith(`${name}=`)), pair].join('; ');
    }
  }

  return async function call(path, { method = 'GET', body, headers = {}, retry = true } = {}) {
    const response = await fetch(`${GATEWAY}/api${path}`, {
      method,
      headers: { 'content-type': 'application/json', cookie: cookies, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    absorb(response);

    /*
     * Adding a member bumps the workspace epoch, which deliberately
     * invalidates every live token so revoked permissions cannot outlive the
     * change. The real client refreshes silently and retries; a harness that
     * does not will see the admin's session die the moment the employee
     * accepts their invitation, and blame the feature.
     */
    if (response.status === 401 && retry && !path.startsWith('/auth/')) {
      const refreshed = await fetch(`${GATEWAY}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: cookies },
        body: '{}',
      });
      absorb(refreshed);
      if (refreshed.ok) return call(path, { method, body, headers, retry: false });
    }

    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
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
const settle = (ms = 1500) => new Promise((r) => setTimeout(r, ms));
const money = (v) => Number(v ?? 0);

function weekday(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const stamp = Date.now();
  console.log(c.bold('\n  Employee portal smoke test\n'));

  const hr = session();
  const portal = session();
  const outsider = session();

  // ── 0 ── a workspace with HR and payroll ────────────────────────────────
  step(0, 'Workspace');
  const reg = await hr('/auth/register', {
    method: 'POST',
    body: { email: `portal+${stamp}@nexus.test`, password: 'correct-horse-battery-7', name: 'Portal Admin' },
  });
  check('admin registered', reg.status === 201, `status ${reg.status}`);

  await hr('/organizations', { method: 'POST', body: { name: `Sahyadri Tools ${stamp}`, size_band: '11-50' } });
  await hr('/auth/refresh', { method: 'POST', body: {} });
  const sub = await hr('/subscriptions', {
    method: 'POST',
    body: { plan: 'growth', app_slugs: ['hr', 'payroll'], seats: 25, cycle: 'monthly' },
  });
  check('subscribed to HR + Payroll', sub.status === 201, JSON.stringify(sub.body?.error ?? '').slice(0, 120));
  await settle();

  // ── 1 ── two employees ──────────────────────────────────────────────────
  step(1, 'Two employees');
  const mineEmail = `arun+${stamp}@nexus.test`;

  const mine = await hr('/hr/employees', {
    method: 'POST',
    body: {
      first_name: 'Arun', last_name: 'Deshpande', email: mineEmail,
      designation: 'Fitter', joined_on: '2023-07-03',
    },
  });
  check('employee created', mine.status === 201, JSON.stringify(mine.body?.error ?? '').slice(0, 120));
  const mineId = mine.body?.data?.id;

  const theirs = await hr('/hr/employees', {
    method: 'POST',
    body: {
      first_name: 'Priya', last_name: 'Nair', email: `priya+${stamp}@nexus.test`,
      designation: 'Supervisor', joined_on: '2022-01-10',
    },
  });
  const theirsId = theirs.body?.data?.id;
  check('colleague created', theirs.status === 201);

  // ── 2 ── inviting to the portal ─────────────────────────────────────────
  step(2, 'Portal invitation');
  const access = await hr('/hr/portal/access');
  check('access list loads', access.status === 200, JSON.stringify(access.body?.error ?? '').slice(0, 120));
  check('nobody has portal access yet', access.body?.meta?.counts?.none === 2,
    JSON.stringify(access.body?.meta?.counts));

  const noEmail = await hr('/hr/employees', {
    method: 'POST', body: { first_name: 'Nobody', last_name: 'Contactable' },
  });
  const inviteAll = await hr('/hr/portal/invite', {
    method: 'POST',
    body: { employee_ids: [mineId, noEmail.body.data.id] },
  });
  check('invitation sent', inviteAll.status === 200, JSON.stringify(inviteAll.body?.error ?? '').slice(0, 160));
  check('one invite went out', inviteAll.body?.meta?.sent === 1, `${inviteAll.body?.meta?.sent}`);
  check('somebody with no email is named, not silently skipped',
    inviteAll.body?.data?.skipped?.some((s) => /email/i.test(s.reason)),
    JSON.stringify(inviteAll.body?.data?.skipped));

  const link = inviteAll.body?.data?.invited?.[0]?.invite_link;
  check('an invite link is returned once', typeof link === 'string' && link.includes('token='));

  const afterInvite = await hr('/hr/portal/access');
  check('the record shows as invited',
    afterInvite.body?.data?.find((r) => r.id === mineId)?.portal_status === 'invited');

  // ── 3 ── the employee accepts and signs in ──────────────────────────────
  step(3, 'Accepting the invitation');
  const token = new URL(link).searchParams.get('token');

  const joined = await portal('/auth/register', {
    method: 'POST',
    body: {
      email: mineEmail, password: 'correct-horse-battery-7',
      name: 'Arun Deshpande', invitation_token: token,
    },
  });
  check('employee account created', joined.status === 201,
    JSON.stringify(joined.body?.error ?? '').slice(0, 160));

  const accepted = await portal('/invitations/accept', { method: 'POST', body: { token } });
  check('invitation accepted', [200, 201, 409].includes(accepted.status),
    `status ${accepted.status} ${JSON.stringify(accepted.body?.error ?? '').slice(0, 120)}`);

  await portal('/auth/refresh', { method: 'POST', body: {} });
  await settle(2000);

  const linked = await hr('/hr/portal/access');
  const linkedRow = linked.body?.data?.find((r) => r.id === mineId);
  check('the employee record is linked to the login automatically',
    linkedRow?.linked === true && linkedRow?.portal_status === 'active',
    JSON.stringify({ linked: linkedRow?.linked, status: linkedRow?.portal_status }));

  // ── 4 ── what the portal sees ───────────────────────────────────────────
  step(4, 'The portal');
  const me = await portal('/hr/me');
  check('the portal loads', me.status === 200, JSON.stringify(me.body?.error ?? '').slice(0, 160));
  check('it shows the right person',
    me.body?.data?.employee?.employee_code === mine.body?.data?.employee_code,
    me.body?.data?.employee?.name);
  check('it carries their shift', Boolean(me.body?.data?.shift?.window), me.body?.data?.shift?.window);
  check('it carries their leave balance',
    (me.body?.data?.leave_balances?.length ?? 0) > 0,
    `${me.body?.data?.leave_balances?.length} types`);

  // ── 5 ── the cage ───────────────────────────────────────────────────────
  step(5, 'What the portal CANNOT see');
  const roster = await portal('/hr/employees');
  check('cannot list the workforce', roster.status === 403, `status ${roster.status}`);

  const colleague = await portal(`/hr/employees/${theirsId}`);
  check('cannot open a colleague’s record', colleague.status === 403, `status ${colleague.status}`);

  const everyoneAttendance = await portal('/hr/attendance/today');
  check('cannot see the attendance board', everyoneAttendance.status === 403,
    `status ${everyoneAttendance.status}`);

  const members = await portal('/members');
  check('cannot list workspace members', members.status === 403, `status ${members.status}`);

  const billing = await portal('/subscriptions');
  check('cannot reach billing', [403, 404].includes(billing.status), `status ${billing.status}`);

  const install = await portal('/apps/crm/install', { method: 'POST', body: {} });
  check('cannot install an app', install.status === 403, `status ${install.status}`);

  const allPayslips = await portal('/payroll/payslips');
  check('cannot list everybody’s payslips', allPayslips.status === 403, `status ${allPayslips.status}`);

  const register = await portal('/payroll/salaries');
  check('cannot read the salary register', register.status === 403, `status ${register.status}`);

  // ── 6 ── applying for leave ─────────────────────────────────────────────
  step(6, 'Leave from the portal');
  const leaveScreen = await portal('/hr/me/leave');
  check('the leave screen loads', leaveScreen.status === 200);
  const casual = leaveScreen.body?.data?.balances?.find((b) => b.code === 'CL');
  check('a leave balance is available', Number(casual?.available) > 0, JSON.stringify(casual));

  const applied = await portal('/hr/me/leave', {
    method: 'POST',
    body: {
      leave_type_id: casual.leave_type_id,
      start_date: weekday(9),
      end_date: weekday(9),
      reason: 'Family function',
    },
  });
  check('leave applied for', applied.status === 201,
    JSON.stringify(applied.body?.error ?? '').slice(0, 160));

  const twice = await portal('/hr/me/leave', {
    method: 'POST',
    body: { leave_type_id: casual.leave_type_id, start_date: weekday(9), end_date: weekday(9) },
  });
  check('the same dates cannot be applied for twice', twice.status === 409, `status ${twice.status}`);

  const tooMuch = await portal('/hr/me/leave', {
    method: 'POST',
    body: {
      leave_type_id: casual.leave_type_id,
      start_date: weekday(40),
      end_date: weekday(400),
    },
  });
  check('the balance check applies to the portal too, not just HR',
    tooMuch.status === 400 && /remain/i.test(tooMuch.body?.error?.message ?? ''),
    tooMuch.body?.error?.message);

  const hrSees = await hr('/hr/leave?status=pending');
  check('HR sees the request the employee raised',
    hrSees.body?.data?.some((r) => r.employee_id === mineId),
    `${hrSees.body?.data?.length} pending`);

  const withdrawn = await portal(`/hr/me/leave/${applied.body.data.id}`, { method: 'DELETE' });
  check('a pending request can be withdrawn', withdrawn.status === 200, `status ${withdrawn.status}`);

  // ── 7 ── payslips ───────────────────────────────────────────────────────
  step(7, 'Payslips in the portal');
  await hr('/payroll/salaries', {
    method: 'POST',
    body: {
      employee_id: mineId, monthly_gross: '38000', effective_from: '2024-04-01',
      bank_account: '50100111222333', bank_ifsc: 'HDFC0000521',
    },
  });
  await hr('/payroll/salaries', {
    method: 'POST',
    body: { employee_id: theirsId, monthly_gross: '64000', effective_from: '2024-04-01' },
  });

  const now = new Date();
  const runMonth = now.getMonth() === 0 ? 12 : now.getMonth();
  const runYear = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();

  const run = await hr('/payroll/runs', { method: 'POST', body: { year: runYear, month: runMonth } });
  await hr(`/payroll/runs/${run.body.data.id}/process`, { method: 'POST', body: {} });

  const beforeApproval = await portal('/payroll/me/payslips');
  check('a payslip in review is not shown to the employee',
    beforeApproval.status === 200 && beforeApproval.body?.data?.length === 0,
    `${beforeApproval.body?.data?.length} visible`);

  await hr(`/payroll/runs/${run.body.data.id}/status`, { method: 'POST', body: { status: 'approved' } });

  const mySlips = await portal('/payroll/me/payslips');
  check('an approved payslip appears', mySlips.body?.data?.length === 1,
    `${mySlips.body?.data?.length}`);
  check('it is their own figure, not a colleague’s',
    money(mySlips.body?.data?.[0]?.gross_earnings) === 38000,
    `${mySlips.body?.data?.[0]?.gross_earnings}`);

  const detail = await portal(`/payroll/me/payslips/${mySlips.body.data[0].id}`);
  check('the payslip opens with its lines',
    (detail.body?.data?.earnings?.length ?? 0) > 0 && (detail.body?.data?.deductions?.length ?? 0) > 0);
  check('the net is written out in words',
    /rupees/i.test(detail.body?.data?.net_pay_words ?? ''), detail.body?.data?.net_pay_words);

  // The crucial one: a colleague's payslip id, in a portal session.
  const runDetail = await hr(`/payroll/runs/${run.body.data.id}`);
  const theirSlip = runDetail.body?.data?.payslips?.find((p) => p.employee_id === theirsId);
  const stolen = await portal(`/payroll/me/payslips/${theirSlip.id}`);
  check('a colleague’s payslip id resolves to nothing', stolen.status === 404,
    `status ${stolen.status}`);

  // ── 8 ── documents ──────────────────────────────────────────────────────
  step(8, 'Employment documents');

  // The salary reaches HR over the bus, so there is a sub-second window where
  // a letter issued immediately after a raise would still say "as discussed".
  // That is the correct behaviour for a projection — better a vague letter
  // than a stale figure — but the test has to wait for it like any consumer.
  await settle();

  const templates = await hr('/hr/letter-templates');
  check('default letter templates exist', (templates.body?.data?.length ?? 0) >= 4,
    templates.body?.data?.map((t) => t.kind).join(', '));

  const offerTemplate = templates.body?.data?.find((t) => t.kind === 'offer');

  const preview = await hr('/hr/employee-documents/preview', {
    method: 'POST',
    body: { employee_id: mineId, template_id: offerTemplate.id },
  });
  check('a letter previews', preview.status === 200,
    JSON.stringify(preview.body?.error ?? '').slice(0, 160));
  check('placeholders are filled from the record',
    preview.body?.data?.body?.includes('Arun Deshpande')
      && preview.body?.data?.body?.includes('Fitter'),
    preview.body?.data?.body?.slice(0, 120));
  check('no placeholder syntax survives into the letter',
    !/\{\{/.test(preview.body?.data?.body ?? '{{'),
    (preview.body?.data?.body ?? '').match(/\{\{[a-z_]+\}\}/gi)?.join(', '));
  check('the salary comes from payroll’s projection, not retyped',
    preview.body?.data?.context?.annual_ctc === '₹4,56,000'
      && preview.body?.data?.body?.includes('4,56,000'),
    preview.body?.data?.context?.annual_ctc);

  const issued = await hr('/hr/employee-documents', {
    method: 'POST',
    body: {
      employee_id: mineId, template_id: offerTemplate.id,
      issue: true, requires_acknowledgement: true,
    },
  });
  check('a letter is issued', issued.status === 201,
    JSON.stringify(issued.body?.error ?? '').slice(0, 160));
  check('it is numbered', /^OFF\/\d{4}\/\d{4}$/.test(issued.body?.data?.reference ?? ''),
    issued.body?.data?.reference);

  const reword = await hr(`/hr/employee-documents/${issued.body.data.id}`, {
    method: 'PATCH', body: { body: 'Actually, never mind.' },
  });
  check('an issued letter cannot be reworded', reword.status === 400,
    reword.body?.error?.message);

  const myDocs = await portal('/hr/me/documents');
  check('the employee sees their letter', myDocs.body?.data?.length === 1,
    `${myDocs.body?.data?.length}`);
  check('it is flagged as needing acknowledgement',
    myDocs.body?.meta?.awaiting_acknowledgement === 1);

  const ack = await portal(`/hr/me/documents/${issued.body.data.id}/acknowledge`, {
    method: 'POST', body: { note: 'Received and accepted.' },
  });
  check('the employee can acknowledge it', ack.status === 200, `status ${ack.status}`);

  const hidden = await hr('/hr/employee-documents', {
    method: 'POST',
    body: {
      employee_id: mineId, kind: 'warning', title: 'Internal note',
      body: 'Not for the employee.', issue: true, visible_to_employee: false,
    },
  });
  const afterHidden = await portal('/hr/me/documents');
  check('a document marked internal is not shown to the employee',
    afterHidden.body?.data?.length === 1 && !afterHidden.body.data.some((d) => d.id === hidden.body.data.id),
    `${afterHidden.body?.data?.length} visible`);

  const stolenDoc = await portal(`/hr/me/documents/${hidden.body.data.id}`);
  check('and its id resolves to nothing in the portal', stolenDoc.status === 404,
    `status ${stolenDoc.status}`);

  // ── 9 ── performance ────────────────────────────────────────────────────
  step(9, 'Performance review');
  const cycle = await hr('/hr/performance/cycles', {
    method: 'POST',
    body: {
      name: `H1 ${runYear}`, period_start: `${runYear}-01-01`, period_end: `${runYear}-06-30`,
      rating_scale: 5,
    },
  });
  check('a review cycle is created', cycle.status === 201,
    JSON.stringify(cycle.body?.error ?? '').slice(0, 160));
  check('it seeds default competencies',
    (cycle.body?.data?.competencies?.length ?? 0) >= 3,
    JSON.stringify(cycle.body?.data?.competencies));

  const enrolled = await hr(`/hr/performance/cycles/${cycle.body.data.id}/enrol`, {
    method: 'POST', body: { everyone: true },
  });
  check('everyone is enrolled', enrolled.body?.data?.enrolled >= 2,
    `${enrolled.body?.data?.enrolled}`);
  check('people without a manager are counted, not hidden',
    typeof enrolled.body?.meta?.without_a_manager === 'number',
    `${enrolled.body?.meta?.without_a_manager}`);

  const notOpen = await portal('/hr/me/performance');
  const draftReview = notOpen.body?.data?.reviews?.[0];
  check('the employee sees the cycle', Boolean(draftReview), JSON.stringify(notOpen.body?.error ?? ''));

  const tooEarly = await portal(`/hr/me/performance/${draftReview.id}/self`, {
    method: 'POST', body: { comments: 'Early!', submit: true },
  });
  check('a self-review cannot be filed before the cycle opens', tooEarly.status === 400,
    tooEarly.body?.error?.message);

  await hr(`/hr/performance/cycles/${cycle.body.data.id}/status`, {
    method: 'POST', body: { status: 'self_review' },
  });

  const selfReview = await portal(`/hr/me/performance/${draftReview.id}/self`, {
    method: 'POST',
    body: {
      scores: { 'Quality of work': 4, Ownership: 5 },
      comments: 'Delivered the line-two retooling ahead of schedule.',
      submit: true,
    },
  });
  check('the employee files a self-review', selfReview.status === 200,
    JSON.stringify(selfReview.body?.error ?? '').slice(0, 160));

  const notMine = await portal('/hr/performance/reviews');
  check('but cannot read everybody’s reviews', notMine.status === 403, `status ${notMine.status}`);

  await hr(`/hr/performance/cycles/${cycle.body.data.id}/status`, {
    method: 'POST', body: { status: 'manager_review' },
  });

  const beforeShare = await portal('/hr/me/performance');
  check('the manager’s words are hidden until the cycle is shared',
    beforeShare.body?.data?.reviews?.[0]?.manager_comments === null,
    JSON.stringify(beforeShare.body?.data?.reviews?.[0]?.manager_comments));

  const reviews = await hr(`/hr/performance/reviews?cycle_id=${cycle.body.data.id}`);
  for (const review of reviews.body.data) {
    await hr(`/hr/performance/reviews/${review.id}`, {
      method: 'PATCH',
      body: {
        manager_scores: { 'Quality of work': 4 },
        manager_comments: 'Reliable and thorough.',
        strengths: 'Precision work.',
        overall_rating: 4,
        recommendation: 'meets',
        submit: true,
      },
    });
  }

  const outOfScale = await hr(`/hr/performance/reviews/${reviews.body.data[0].id}`, {
    method: 'PATCH', body: { overall_rating: 9 },
  });
  check('a rating beyond the scale is refused', outOfScale.status === 400,
    outOfScale.body?.error?.message);

  await hr(`/hr/performance/cycles/${cycle.body.data.id}/status`, {
    method: 'POST', body: { status: 'calibration' },
  });
  const shared = await hr(`/hr/performance/cycles/${cycle.body.data.id}/status`, {
    method: 'POST', body: { status: 'shared' },
  });
  check('the cycle is shared', shared.body?.data?.status === 'shared',
    JSON.stringify(shared.body?.error ?? '').slice(0, 160));

  const afterShare = await portal('/hr/me/performance');
  check('now the employee can read the manager’s words',
    afterShare.body?.data?.reviews?.[0]?.manager_comments === 'Reliable and thorough.',
    afterShare.body?.data?.reviews?.[0]?.manager_comments);
  check('and their rating', Number(afterShare.body?.data?.reviews?.[0]?.overall_rating) === 4);

  const frozen = await hr(`/hr/performance/reviews/${reviews.body.data[0].id}`, {
    method: 'PATCH', body: { overall_rating: 2 },
  });
  check('a shared rating can no longer be changed', frozen.status === 400,
    frozen.body?.error?.message);

  const acked = await portal(`/hr/me/performance/${draftReview.id}/acknowledge`, {
    method: 'POST', body: { note: 'Read and discussed.' },
  });
  check('the employee acknowledges it', acked.status === 200, `status ${acked.status}`);

  const report = await hr(`/hr/performance/report?cycle_id=${cycle.body.data.id}`);
  check('the performance report loads', report.status === 200);
  check('it averages the ratings', Number(report.body?.meta?.average_rating) === 4,
    `${report.body?.meta?.average_rating}`);
  check('it shows the distribution', report.body?.meta?.distribution?.['4'] >= 2,
    JSON.stringify(report.body?.meta?.distribution));
  check('it counts acknowledgements', report.body?.meta?.acknowledged === 1,
    `${report.body?.meta?.acknowledged}`);

  // ── 10 ── another tenant entirely ───────────────────────────────────────
  step(10, 'Another workspace');
  await outsider('/auth/register', {
    method: 'POST',
    body: { email: `other+${stamp}@nexus.test`, password: 'correct-horse-battery-7', name: 'Other Admin' },
  });
  await outsider('/organizations', { method: 'POST', body: { name: `Other Tools ${stamp}` } });
  await outsider('/auth/refresh', { method: 'POST', body: {} });
  await outsider('/subscriptions', {
    method: 'POST', body: { plan: 'growth', app_slugs: ['hr', 'payroll'], seats: 5, cycle: 'monthly' },
  });
  await settle();

  const leakDoc = await outsider(`/hr/employee-documents/${issued.body.data.id}`);
  check('cannot read another tenant’s letter', leakDoc.status === 404, `status ${leakDoc.status}`);

  const leakCycle = await outsider(`/hr/performance/report?cycle_id=${cycle.body.data.id}`);
  check('cannot read another tenant’s review cycle',
    (leakCycle.body?.data?.length ?? 0) === 0, `${leakCycle.body?.data?.length} rows`);

  const leakAccess = await outsider('/hr/portal/access');
  check('cannot see another tenant’s portal users',
    (leakAccess.body?.data?.length ?? -1) === 0, `${leakAccess.body?.data?.length}`);

  // ── 11 ── revoking access ───────────────────────────────────────────────
  step(11, 'Revoking access');
  const revoked = await hr('/hr/portal/revoke', { method: 'POST', body: { employee_id: mineId } });
  check('access revoked', revoked.status === 200, `status ${revoked.status}`);

  await portal('/auth/refresh', { method: 'POST', body: {} });
  const afterRevoke = await portal('/hr/me');
  check('the portal stops resolving to an employee',
    afterRevoke.status === 403 && afterRevoke.body?.error?.details?.code === 'no_employee_record',
    `status ${afterRevoke.status} ${afterRevoke.body?.error?.message}`);

  const payslipsAfter = await portal('/payroll/me/payslips');
  check('and so do their payslips', payslipsAfter.status === 403, `status ${payslipsAfter.status}`);

  console.log('');
  if (failures === 0) {
    console.log(c.ok(c.bold('  ✔ everything passed\n')));
    process.exit(0);
  }
  console.log(c.bad(c.bold(`  ✘ ${failures} check${failures === 1 ? '' : 's'} failed\n`)));
  process.exit(1);
}

main().catch((error) => {
  console.error(`\n  ${c.bad('portal smoke crashed:')} ${error.stack}\n`);
  process.exit(1);
});
