#!/usr/bin/env node
/**
 * Notifications, end to end.
 *
 * Three people in one workspace — an owner who approves, an HR clerk who
 * cannot, and an employee on the portal — and a stranger in another. Most of
 * the checks are about who does NOT get told: the person who acted, the
 * person without the permission, the other tenant.
 */
const GATEWAY = process.env.API_URL ?? 'http://localhost:4000';
let failures = 0;
const c = { ok: (s) => `\x1b[32m${s}\x1b[0m`, bad: (s) => `\x1b[31m${s}\x1b[0m`, dim: (s) => `\x1b[90m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m` };

function session() {
  let cookies = '';
  const absorb = (response) => {
    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const [name] = pair.split('=');
      cookies = [...cookies.split('; ').filter((x) => x && !x.startsWith(`${name}=`)), pair].join('; ');
    }
  };
  return async function call(path, { method = 'GET', body, retry = true } = {}) {
    const response = await fetch(`${GATEWAY}/api${path}`, {
      method, headers: { 'content-type': 'application/json', cookie: cookies },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    absorb(response);
    if (response.status === 401 && retry && !path.startsWith('/auth/')) {
      const refreshed = await fetch(`${GATEWAY}/api/auth/refresh`, {
        method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies }, body: '{}',
      });
      absorb(refreshed);
      if (refreshed.ok) return call(path, { method, body, retry: false });
    }
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
}

function check(label, condition, detail) {
  if (condition) console.log(`  ${c.ok('✔')} ${label}`);
  else { failures += 1; console.log(`  ${c.bad('✘')} ${label}${detail ? c.dim(`  → ${detail}`) : ''}`); }
}
const step = (n, label) => console.log(`\n${c.bold(`${n}. ${label}`)}`);
const settle = (ms = 1800) => new Promise((r) => setTimeout(r, ms));

/** Poll the inbox until something matching arrives, or give up. Events are async. */
async function waitFor(call, predicate, { tries = 12, gap = 400 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    const inbox = await call('/notifications');
    const hit = inbox.body?.data?.find(predicate);
    if (hit) return { hit, inbox };
    await settle(gap);
  }
  return { hit: null, inbox: await call('/notifications') };
}

function pastWeekday(n) {
  const d = new Date(); let found = 0;
  while (found < n) { d.setDate(d.getDate() - 1); if (d.getDay() !== 0 && d.getDay() !== 6) found += 1; }
  return d.toISOString().slice(0, 10);
}
function futureWeekday(n) {
  const d = new Date(); let found = 0;
  while (found < n) { d.setDate(d.getDate() + 1); if (d.getDay() !== 0 && d.getDay() !== 6) found += 1; }
  return d.toISOString().slice(0, 10);
}

async function join(owner, who, email, roleSlug, stamp) {
  const roles = await owner('/roles');
  const role = roles.body.data.find((r) => r.slug === roleSlug);
  const invite = await owner('/invitations', { method: 'POST', body: { email, role_ids: [role.id] } });
  const token = new URL(invite.body.data.invite_link).searchParams.get('token');
  await who('/auth/register', { method: 'POST', body: { email, password: 'correct-horse-battery-7', name: roleSlug, invitation_token: token } });
  await who('/invitations/accept', { method: 'POST', body: { token } });
  await who('/auth/refresh', { method: 'POST', body: {} });
  void stamp;
}

async function main() {
  const stamp = Date.now();
  console.log(c.bold('\n  Notifications smoke test\n'));
  const owner = session(); const clerk = session(); const employee = session(); const stranger = session();

  step(0, 'A workspace with three people');
  await owner('/auth/register', { method: 'POST', body: { email: `ntf+${stamp}@nexus.test`, password: 'correct-horse-battery-7', name: 'Owner' } });
  await owner('/organizations', { method: 'POST', body: { name: `Notify Works ${stamp}` } });
  await owner('/auth/refresh', { method: 'POST', body: {} });
  const sub = await owner('/subscriptions', { method: 'POST', body: { plan: 'growth', app_slugs: ['hr', 'tasks'], seats: 10, cycle: 'monthly' } });
  check('subscribed to HR and Tasks', sub.status === 201, JSON.stringify(sub.body?.error ?? '').slice(0, 140));
  await settle();

  await join(owner, clerk, `ntf-clerk+${stamp}@nexus.test`, 'member', stamp);
  const empEmail = `ntf-emp+${stamp}@nexus.test`;
  const emp = await owner('/hr/employees', { method: 'POST', body: { first_name: 'Asha', last_name: 'Rao', email: empEmail, joined_on: '2023-02-01' } });
  const invite = await owner('/hr/portal/invite', { method: 'POST', body: { employee_ids: [emp.body.data.id] } });
  const token = new URL(invite.body.data.invited[0].invite_link).searchParams.get('token');
  await employee('/auth/register', { method: 'POST', body: { email: empEmail, password: 'correct-horse-battery-7', name: 'Asha Rao', invitation_token: token } });
  await employee('/invitations/accept', { method: 'POST', body: { token } });
  await employee('/auth/refresh', { method: 'POST', body: {} });
  await settle(2200);
  const me = await employee('/hr/me');
  check('the employee is linked and on the portal', me.status === 200, `status ${me.status}`);

  const empty = await owner('/notifications');
  check('the inbox works', empty.status === 200, JSON.stringify(empty.body?.error ?? '').slice(0, 140));

  // ── attendance ──────────────────────────────────────────────────────────
  step(1, 'An attendance correction reaches the approver');
  const day = pastWeekday(2);
  const claim = await employee('/hr/me/attendance/requests', {
    method: 'POST', body: { on_date: day, status: 'present', reason: 'Terminal was offline' },
  });
  check('the employee raises a correction', claim.status === 201, `status ${claim.status}`);

  const ownerSees = await waitFor(owner, (n) => n.kind === 'attendance.request');
  check('the owner, who can approve, is told', Boolean(ownerSees.hit), `${ownerSees.inbox.body?.data?.length} in inbox`);
  check('with who and which day', /Asha Rao/.test(ownerSees.hit?.title ?? '') && Boolean(ownerSees.hit?.link),
    ownerSees.hit?.title);

  await settle(600);
  const clerkInbox = await clerk('/notifications');
  check('the clerk, who cannot approve, is not',
    !clerkInbox.body?.data?.some((n) => n.kind === 'attendance.request'), `${clerkInbox.body?.data?.length} items`);
  const empInbox = await employee('/notifications');
  check('the employee is not told about their own request',
    !empInbox.body?.data?.some((n) => n.kind === 'attendance.request'));

  await owner(`/hr/attendance/requests/${claim.body.data.id}/decide`, {
    method: 'POST', body: { decision: 'approved', note: 'Confirmed with security.' },
  });
  const decided = await waitFor(employee, (n) => n.kind === 'attendance.decided');
  check('the employee hears it was approved', /approved/.test(decided.hit?.title ?? ''), decided.hit?.title);
  check('and the note travels with it', decided.hit?.body === 'Confirmed with security.', decided.hit?.body);
  check('pointing at their portal', decided.hit?.link === '/portal/attendance', decided.hit?.link);

  // ── leave ───────────────────────────────────────────────────────────────
  step(2, 'Leave goes to approvers, and the answer comes back');
  const balances = await employee('/hr/me/leave');
  const casual = balances.body.data.balances.find((b) => b.code === 'CL');
  const leave = await employee('/hr/me/leave', {
    method: 'POST', body: { leave_type_id: casual.leave_type_id, start_date: futureWeekday(10), end_date: futureWeekday(11), reason: 'Wedding' },
  });
  check('leave requested', leave.status === 201, JSON.stringify(leave.body?.error ?? '').slice(0, 140));
  const leaveNote = await waitFor(owner, (n) => n.kind === 'leave.request');
  check('the approver is told', /Asha Rao/.test(leaveNote.hit?.title ?? ''), leaveNote.hit?.title);
  check('with the dates in words, not ISO', /\d{1,2} [A-Z][a-z]{2}/.test(leaveNote.hit?.body ?? ''), leaveNote.hit?.body);

  await owner(`/hr/leave/${leave.body.data.id}/decide`, {
    method: 'POST', body: { decision: 'rejected', note: 'Quarter-end close that week.' },
  });
  const leaveAnswer = await waitFor(employee, (n) => n.kind === 'leave.decided');
  check('a rejection is news too', /rejected/.test(leaveAnswer.hit?.title ?? ''), leaveAnswer.hit?.title);
  check('with the reason', leaveAnswer.hit?.body === 'Quarter-end close that week.', leaveAnswer.hit?.body);

  // ── documents ───────────────────────────────────────────────────────────
  step(3, 'A letter that needs acknowledging');
  const templates = await owner('/hr/letter-templates');
  const tpl = templates.body.data.find((t) => t.kind === 'confirmation');
  await owner('/hr/employee-documents', { method: 'POST', body: { employee_id: emp.body.data.id, template_id: tpl.id, issue: true, requires_acknowledgement: true } });
  const docNote = await waitFor(employee, (n) => n.kind === 'document.issued');
  check('the employee is asked to read it', /acknowledge/i.test(docNote.hit?.title ?? ''), docNote.hit?.title);

  await owner('/hr/employee-documents', { method: 'POST', body: { employee_id: emp.body.data.id, kind: 'warning', title: 'Internal note', body: 'x', issue: true, visible_to_employee: false } });
  await settle(1500);
  const afterInternal = await employee('/notifications');
  check('an internal document announces nothing',
    !afterInternal.body?.data?.some((n) => /Internal note/.test(n.title)));

  // ── tasks ───────────────────────────────────────────────────────────────
  step(4, 'Tasks');
  const clerkMe = await clerk('/auth/me');
  const clerkUserId = clerkMe.body?.data?.user?.id ?? clerkMe.body?.data?.id;
  const assigned = await owner('/tasks', { method: 'POST', body: { title: 'Reconcile September overtime', assignee_id: clerkUserId, due_date: futureWeekday(3) } });
  check('a task is assigned at creation', assigned.status === 201, JSON.stringify(assigned.body?.error ?? '').slice(0, 160));
  const taskNote = await waitFor(clerk, (n) => n.kind === 'task.assigned');
  check('the assignee is told on creation, not only on reassignment', Boolean(taskNote.hit), taskNote.hit?.title);
  check('and the link opens that task', taskNote.hit?.link === `/tasks?task=${assigned.body?.data?.id}`, taskNote.hit?.link);

  await owner('/tasks', { method: 'POST', body: { title: 'Self-assigned', assignee_id: (await owner('/auth/me')).body?.data?.user?.id } });
  await settle(1500);
  const ownerAfterSelf = await owner('/notifications');
  check('assigning yourself sends yourself nothing',
    !ownerAfterSelf.body?.data?.some((n) => /Self-assigned/.test(n.title)));

  await clerk(`/tasks/${assigned.body.data.id}`, { method: 'PATCH', body: { status: 'done' } });
  const doneNote = await waitFor(owner, (n) => n.kind === 'task.completed');
  check('the person who created it hears it is done', Boolean(doneNote.hit), doneNote.hit?.title);

  // ── reading ─────────────────────────────────────────────────────────────
  step(5, 'Reading and counting');
  const count = await owner('/notifications/unread-count');
  check('the bell has a real number', count.body?.data?.unread >= 3, `${count.body?.data?.unread}`);
  const first = (await owner('/notifications')).body.data[0];
  await owner('/notifications/read', { method: 'POST', body: { ids: [first.id] } });
  const after = await owner('/notifications/unread-count');
  check('reading one takes one off', after.body.data.unread === count.body.data.unread - 1, `${after.body.data.unread}`);

  const stolen = await clerk('/notifications/read', { method: 'POST', body: { ids: [(await owner('/notifications')).body.data[1].id] } });
  check('marking someone else’s as read does nothing', stolen.body?.data?.marked === 0, JSON.stringify(stolen.body));

  await owner('/notifications/read', { method: 'POST', body: { all: true } });
  check('mark all read', (await owner('/notifications/unread-count')).body.data.unread === 0);

  // ── another tenant ──────────────────────────────────────────────────────
  step(6, 'Another workspace');
  await stranger('/auth/register', { method: 'POST', body: { email: `ntf-x+${stamp}@nexus.test`, password: 'correct-horse-battery-7', name: 'Other Owner' } });
  await stranger('/organizations', { method: 'POST', body: { name: `Elsewhere ${stamp}` } });
  await stranger('/auth/refresh', { method: 'POST', body: {} });
  const theirs = await stranger('/notifications');
  check('sees none of this workspace’s notifications', theirs.body?.data?.length === 0, `${theirs.body?.data?.length}`);

  console.log('');
  if (failures === 0) { console.log(c.ok(c.bold('  ✔ everything passed\n'))); process.exit(0); }
  console.log(c.bad(c.bold(`  ✘ ${failures} check${failures === 1 ? '' : 's'} failed\n`)));
  process.exit(1);
}

main().catch((error) => { console.error(`\n  ${c.bad('notifications smoke crashed:')} ${error.stack}\n`); process.exit(1); });
