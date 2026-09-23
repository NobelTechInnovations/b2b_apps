#!/usr/bin/env node
/**
 * HR end-to-end check.
 *
 * Runs the real people motion through the public gateway: hire someone, place
 * them in a department under a manager, mark attendance, request and approve
 * leave, then offboard them — checking that balances, calendars and reporting
 * lines all stay consistent.
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

/** Next weekday at least `offset` days out, so tests never land on a weekend. */
function weekday(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const stamp = Date.now();
  console.log(c.bold('\n  HR smoke test\n'));

  step(0, 'Workspace with HR installed');
  const reg = await call('/auth/register', {
    method: 'POST',
    body: { email: `hr+${stamp}@nexus.test`, password: 'correct-horse-battery-7', name: 'HR Tester' },
  });
  check('registered', reg.status === 201, `status ${reg.status}`);

  await call('/organizations', { method: 'POST', body: { name: `Lumen Works ${stamp}`, size_band: '11-50' } });
  await call('/auth/refresh', { method: 'POST', body: {} });
  const sub = await call('/subscriptions', {
    method: 'POST',
    body: { plan: 'growth', app_slugs: ['hr'], seats: 25, cycle: 'monthly' },
  });
  check('subscribed to HR', sub.status === 201, `status ${sub.status}`);
  await new Promise((r) => setTimeout(r, 1500));

  // ── 1 ── leave policy exists without configuration ──────────────────────
  step(1, 'Leave policy ready out of the box');
  const types = await call('/hr/leave-types');
  check('default leave types seeded', (types.body?.data?.length ?? 0) === 4,
    types.body?.data?.map((t) => t.code).join(', '));
  const casual = types.body?.data?.find((t) => t.code === 'CL');
  const unpaid = types.body?.data?.find((t) => t.code === 'LWP');
  check('casual leave is paid and has an entitlement',
    casual?.is_paid === true && Number(casual?.days_per_year) === 12,
    `${casual?.days_per_year} days`);

  // ── 2 ── departments ────────────────────────────────────────────────────
  step(2, 'Departments');
  const dept = await call('/hr/departments', { method: 'POST', body: { name: 'Engineering', code: 'ENG' } });
  check('department created', dept.status === 201, `status ${dept.status}`);
  const deptId = dept.body?.data?.id;

  const dupe = await call('/hr/departments', { method: 'POST', body: { name: 'engineering' } });
  check('duplicate name refused (case-insensitive)', dupe.status === 409, `status ${dupe.status}`);

  // ── 3 ── hire ───────────────────────────────────────────────────────────
  step(3, 'Hire people');
  const manager = await call('/hr/employees', {
    method: 'POST',
    body: {
      first_name: 'Rhea', last_name: 'Kapoor', email: 'rhea@lumen.test',
      designation: 'Engineering Manager', department_id: deptId, joined_on: '2024-02-01',
    },
  });
  check('manager hired', manager.status === 201, `status ${manager.status}`);
  const managerId = manager.body?.data?.id;
  check('employee code auto-generated', manager.body?.data?.employee_code === 'EMP-001',
    manager.body?.data?.employee_code);

  const staff = await call('/hr/employees', {
    method: 'POST',
    body: {
      first_name: 'Vikram', last_name: 'Rao', email: 'vikram@lumen.test',
      designation: 'Senior Engineer', department_id: deptId, manager_id: managerId,
      date_of_birth: '1992-06-14', joined_on: '2025-03-10',
    },
  });
  check('report hired', staff.status === 201, `status ${staff.status}`);
  const staffId = staff.body?.data?.id;
  check('codes increment', staff.body?.data?.employee_code === 'EMP-002',
    staff.body?.data?.employee_code);

  const dupeEmail = await call('/hr/employees', {
    method: 'POST',
    body: { first_name: 'Copy', email: 'vikram@lumen.test' },
  });
  check('duplicate work email refused', dupeEmail.status === 409, `status ${dupeEmail.status}`);

  const selfManage = await call(`/hr/employees/${staffId}`, {
    method: 'PATCH', body: { manager_id: staffId },
  });
  check('cannot report to self', selfManage.status === 400, `status ${selfManage.status}`);

  const loop = await call(`/hr/employees/${managerId}`, {
    method: 'PATCH', body: { manager_id: staffId },
  });
  check('circular reporting line refused', loop.status === 400, `status ${loop.status}`);

  // ── 4 ── opening balances ───────────────────────────────────────────────
  step(4, 'Leave balances open automatically');
  const balances = await call(`/hr/leave-balances/${staffId}`);
  const clBalance = balances.body?.data?.find((b) => b.code === 'CL');
  check('balances created on hire', (balances.body?.data?.length ?? 0) === 4);
  check('casual leave starts at 12 available', Number(clBalance?.available) === 12,
    `${clBalance?.available} available`);

  // ── 5 ── attendance ─────────────────────────────────────────────────────
  step(5, 'Attendance');
  const checkIn = await call('/hr/attendance/check-in', { method: 'POST', body: { employee_id: staffId } });
  check('check-in recorded', checkIn.status === 200 && Boolean(checkIn.body?.data?.check_in_at));

  const twice = await call('/hr/attendance/check-in', { method: 'POST', body: { employee_id: staffId } });
  check('double check-in refused', twice.status === 400, `status ${twice.status}`);

  const checkOut = await call('/hr/attendance/check-out', { method: 'POST', body: { employee_id: staffId } });
  check('check-out computes worked minutes',
    checkOut.status === 200 && checkOut.body?.data?.work_minutes !== null,
    `${checkOut.body?.data?.work_minutes} minutes`);

  const board = await call('/hr/attendance/today');
  check('today board lists everyone', (board.body?.data?.length ?? 0) === 2,
    `${board.body?.data?.length} people`);
  check('unmarked people are visible', board.body?.meta?.counts?.not_marked === 1,
    `${board.body?.meta?.counts?.not_marked} not marked`);

  // ── 6 ── request leave ──────────────────────────────────────────────────
  step(6, 'Request and approve leave');
  const from = weekday(7);
  const to = weekday(9);

  const request = await call('/hr/leave', {
    method: 'POST',
    body: { employee_id: staffId, leave_type_id: casual.id, start_date: from, end_date: to, reason: 'Family wedding' },
  });
  check('leave requested', request.status === 201, `status ${request.status}`);
  check('weekends excluded from the day count',
    Number(request.body?.data?.days) > 0 && Number(request.body?.data?.days) <= 3,
    `${request.body?.data?.days} days for ${from} → ${to}`);
  const requestId = request.body?.data?.id;

  const overlap = await call('/hr/leave', {
    method: 'POST',
    body: { employee_id: staffId, leave_type_id: casual.id, start_date: from, end_date: to },
  });
  check('overlapping request refused', overlap.status === 409, `status ${overlap.status}`);

  const tooMuch = await call('/hr/leave', {
    method: 'POST',
    body: { employee_id: staffId, leave_type_id: casual.id, start_date: weekday(40), end_date: weekday(80) },
  });
  check('request beyond balance refused', tooMuch.status === 400, `status ${tooMuch.status}`);

  const unpaidOk = await call('/hr/leave', {
    method: 'POST',
    body: { employee_id: managerId, leave_type_id: unpaid.id, start_date: weekday(40), end_date: weekday(44) },
  });
  check('unpaid leave is not balance-limited', unpaidOk.status === 201, `status ${unpaidOk.status}`);

  // ── 7 ── approve ────────────────────────────────────────────────────────
  step(7, 'Approval side effects');
  const days = Number(request.body?.data?.days);
  const decide = await call(`/hr/leave/${requestId}/decide`, {
    method: 'POST', body: { decision: 'approved', note: 'Enjoy' },
  });
  check('approved', decide.body?.data?.status === 'approved', decide.body?.data?.status);

  const afterApproval = await call(`/hr/leave-balances/${staffId}`);
  const clAfter = afterApproval.body?.data?.find((b) => b.code === 'CL');
  check('balance deducted', Number(clAfter?.used) === days, `${clAfter?.used} used`);
  check('available reduced', Number(clAfter?.available) === 12 - days, `${clAfter?.available} left`);

  const calendar = await call('/hr/attendance', {
    method: 'GET',
  });
  const onLeaveDays = calendar.body?.data?.filter((a) => a.status === 'on_leave').length ?? 0;
  check('calendar blocked out for the leave', onLeaveDays === days,
    `${onLeaveDays} days marked on_leave`);

  const markOver = await call('/hr/attendance', {
    method: 'POST', body: { employee_id: staffId, on_date: from, status: 'present' },
  });
  check('cannot mark present over approved leave', markOver.status === 400, `status ${markOver.status}`);

  const twiceDecided = await call(`/hr/leave/${requestId}/decide`, {
    method: 'POST', body: { decision: 'rejected' },
  });
  check('deciding twice refused', twiceDecided.status === 400, `status ${twiceDecided.status}`);

  // ── 8 ── cancel restores ────────────────────────────────────────────────
  step(8, 'Cancelling restores the balance');
  const cancel = await call(`/hr/leave/${requestId}/cancel`, { method: 'POST' });
  check('cancelled', cancel.status === 200);

  const restored = await call(`/hr/leave-balances/${staffId}`);
  const clRestored = restored.body?.data?.find((b) => b.code === 'CL');
  check('days returned to the balance', Number(clRestored?.used) === 0, `${clRestored?.used} used`);

  const clearedCalendar = await call('/hr/attendance', { method: 'GET' });
  check('calendar marks removed',
    (clearedCalendar.body?.data?.filter((a) => a.status === 'on_leave').length ?? 0) === 0);

  // ── 9 ── overview ───────────────────────────────────────────────────────
  step(9, 'Overview reflects reality');
  const overview = await call('/hr/overview');
  check('overview loads', overview.status === 200);
  check('headcount correct', overview.body?.data?.people?.headcount === 2,
    `${overview.body?.data?.people?.headcount}`);
  check('department headcount rolled up',
    overview.body?.data?.by_department?.[0]?.headcount === 2,
    JSON.stringify(overview.body?.data?.by_department?.[0]));

  const widgets = await call('/hr/widgets');
  check('dashboard widgets served',
    widgets.status === 200 && widgets.body?.data?.['hr.headcount']?.value === 2);

  // ── 10 ── offboard ──────────────────────────────────────────────────────
  step(10, 'Offboarding');
  const blocked = await call(`/hr/departments/${deptId}`, { method: 'DELETE' });
  check('cannot delete a staffed department', blocked.status === 400, `status ${blocked.status}`);

  const offboard = await call(`/hr/employees/${managerId}/offboard`, {
    method: 'POST', body: { exit_reason: 'Moved abroad' },
  });
  check('offboarded', offboard.status === 200 && offboard.body?.data?.offboarded === true);
  check('direct reports reassigned', offboard.body?.data?.reports_reassigned === 1,
    `${offboard.body?.data?.reports_reassigned} reports`);
  check('pending leave cancelled', offboard.body?.data?.leave_requests_cancelled === 1,
    `${offboard.body?.data?.leave_requests_cancelled} cancelled`);

  const afterExit = await call('/hr/overview');
  check('headcount drops after exit', afterExit.body?.data?.people?.headcount === 1,
    `${afterExit.body?.data?.people?.headcount}`);

  // ── 11 ── isolation ─────────────────────────────────────────────────────
  step(11, 'Tenant isolation');
  await call('/auth/logout', { method: 'POST' });
  cookies = '';
  await call('/auth/register', {
    method: 'POST',
    body: { email: `hrother+${stamp}@nexus.test`, password: 'correct-horse-battery-7', name: 'Other HR' },
  });
  await call('/organizations', { method: 'POST', body: { name: `Other HR ${stamp}` } });
  await call('/auth/refresh', { method: 'POST', body: {} });
  await call('/subscriptions', {
    method: 'POST', body: { plan: 'growth', app_slugs: ['hr'], seats: 5, cycle: 'monthly' },
  });
  await new Promise((r) => setTimeout(r, 1200));

  const leak = await call('/hr/employees');
  check('a new workspace sees no other tenant’s people',
    (leak.body?.data?.length ?? -1) === 0, `${leak.body?.data?.length} visible`);

  const leakRead = await call(`/hr/employees/${staffId}`);
  check('cannot read another tenant’s employee by id', leakRead.status === 404,
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
  console.error(`\n  ${c.bad('hr smoke crashed:')} ${error.stack}\n`);
  process.exit(1);
});
