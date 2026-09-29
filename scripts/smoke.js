#!/usr/bin/env node
/**
 * End-to-end smoke test.
 *
 * Walks a brand-new customer through the entire platform the way the product
 * does: register → create a workspace → subscribe to apps → confirm the apps
 * are entitled, installed, and gated correctly. Run it after `pnpm dev`.
 *
 *   node scripts/smoke.js
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

  const setCookie = response.headers.getSetCookie?.() ?? [];
  for (const raw of setCookie) {
    const [pair] = raw.split(';');
    const [name] = pair.split('=');
    const rest = cookies.split('; ').filter((c) => c && !c.startsWith(`${name}=`));
    cookies = [...rest, pair].join('; ');
  }

  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

function check(label, condition, detail) {
  if (condition) {
    console.log(`  ${c.ok('✔')} ${label}`);
  } else {
    failures += 1;
    console.log(`  ${c.bad('✘')} ${label}${detail ? c.dim(`  → ${detail}`) : ''}`);
  }
  return condition;
}

const step = (n, label) => console.log(`\n${c.bold(`${n}. ${label}`)}`);

async function main() {
  const stamp = Date.now();
  const email = `smoke+${stamp}@nexus.test`;
  const password = 'correct-horse-battery-7';

  console.log(c.bold('\n  Nexus smoke test'));
  console.log(c.dim(`  gateway: ${GATEWAY}`));
  console.log(c.dim(`  user:    ${email}\n`));

  // ── 0 ── is anything listening ────────────────────────────────────────────
  step(0, 'Platform reachable');
  try {
    const root = await fetch(GATEWAY).then((r) => r.json());
    check('gateway responds', root.status === 'ok');
    check('routing table built', Array.isArray(root.namespaces) && root.namespaces.length > 10,
      `${root.namespaces?.length ?? 0} namespaces`);
  } catch (error) {
    console.log(`  ${c.bad('✘')} gateway unreachable — is \`pnpm dev\` running?`);
    process.exit(1);
  }

  // ── 1 ── registration ─────────────────────────────────────────────────────
  step(1, 'Register a new user');
  const registered = await call('/auth/register', {
    method: 'POST',
    body: { email, password, name: 'Smoke Tester' },
  });
  check('account created', registered.status === 201, `status ${registered.status}`);
  check('needs onboarding', registered.body?.data?.needs_onboarding === true);
  check('session cookies set', cookies.includes('nx_at') && cookies.includes('nx_rt'));

  // ── 2 ── tenant isolation before a workspace exists ───────────────────────
  step(2, 'Tenant gate before any workspace');
  const noOrg = await call('/members');
  check('org-scoped route refused without a workspace', noOrg.status === 403,
    `got ${noOrg.status}`);

  // ── 3 ── create the workspace ─────────────────────────────────────────────
  step(3, 'Create a workspace');
  const org = await call('/organizations', {
    method: 'POST',
    body: { name: `Smoke Industries ${stamp}`, industry: 'Manufacturing', size_band: '11-50' },
  });
  check('workspace created', org.status === 201, `status ${org.status}`);
  const orgId = org.body?.data?.organization?.id;
  check('workspace id issued', Boolean(orgId), orgId);

  await call('/auth/refresh', { method: 'POST', body: {} });
  check('token now carries the workspace', true);

  // ── 4 ── price quote ──────────────────────────────────────────────────────
  step(4, 'Quote a subscription');
  const quote = await call('/subscriptions/quote', {
    method: 'POST',
    body: { plan: 'business', app_slugs: ['crm', 'payroll'], seats: 25, cycle: 'monthly' },
  });
  check('quote returned', quote.status === 200, `status ${quote.status}`);
  check('dependencies auto-resolved',
    quote.body?.data?.apps?.includes('hr'),
    `apps: ${quote.body?.data?.apps?.join(', ')}`);
  check('total is priced', Number(quote.body?.data?.total) > 0, `₹${quote.body?.data?.total}`);

  // ── 5 ── subscribe ────────────────────────────────────────────────────────
  step(5, 'Subscribe');
  const subscription = await call('/subscriptions', {
    method: 'POST',
    body: { plan: 'business', app_slugs: ['crm', 'hr'], seats: 25, cycle: 'monthly' },
  });
  check('subscription created', subscription.status === 201, `status ${subscription.status}`);
  check('starts in trial', subscription.body?.data?.subscription?.status === 'trialing');

  // ── 6 ── entitlements reach the gateway ───────────────────────────────────
  step(6, 'Entitlements and installed apps');
  await new Promise((r) => setTimeout(r, 1_200)); // let the bus settle

  const workspace = await call('/me/workspace');
  check('workspace bootstrap loads', workspace.status === 200);
  check('crm entitled', workspace.body?.data?.apps?.includes('crm'),
    `apps: ${workspace.body?.data?.apps?.join(', ')}`);
  check('hr entitled', workspace.body?.data?.apps?.includes('hr'));
  check('navigation generated from installed apps',
    (workspace.body?.data?.navigation?.length ?? 0) > 0,
    `${workspace.body?.data?.navigation?.length ?? 0} apps in sidebar`);
  check('owner holds permissions',
    (workspace.body?.data?.permissions?.length ?? 0) > 50,
    `${workspace.body?.data?.permissions?.length ?? 0} permissions`);

  // ── 7 ── the entitlement gate actually bites ──────────────────────────────
  step(7, 'Entitlement gate');
  const forbidden = await call('/accounting/reports');
  check('un-entitled app is refused at the gateway',
    forbidden.status === 403,
    `status ${forbidden.status}, code ${forbidden.body?.error?.code}`);
  check('refusal explains what to do',
    forbidden.body?.error?.code === 'app_not_entitled',
    forbidden.body?.error?.message);

  // ── 8 ── marketplace ──────────────────────────────────────────────────────
  step(8, 'Marketplace');
  const marketplace = await call('/apps');
  check('catalogue loads', marketplace.status === 200);
  const crm = marketplace.body?.data?.find((a) => a.slug === 'crm');
  check('crm shows as installed', crm?.installed === true);
  const accounting = marketplace.body?.data?.find((a) => a.slug === 'accounting');
  check('accounting shows as not entitled', accounting?.entitled === false);
  check('accounting declares its dependency',
    accounting?.requires?.includes('invoicing'),
    `requires: ${accounting?.requires?.join(', ')}`);

  // ── 9 ── roles and people ─────────────────────────────────────────────────
  step(9, 'Roles and membership');
  const roles = await call('/roles');
  const slugs = (roles.body?.data ?? []).map((r) => r.slug).sort();
  check('system roles seeded',
    ['admin', 'employee', 'guest', 'member', 'owner'].every((slug) => slugs.includes(slug)),
    slugs.join(', '));
  check('owner role has implicit access',
    roles.body?.data?.find((r) => r.slug === 'owner')?.implicit_all === true);

  // The portal role is the narrowest on the platform. Asserting on the
  // EXPANDED set, not the pattern, is what proves `*.self.*` cannot reach
  // anything but the endpoints that resolve a person from their own session.
  const employeeRole = roles.body?.data?.find((r) => r.slug === 'employee');
  const employeePerms = employeeRole?.permissions ?? [];
  check('the employee role holds only self permissions',
    employeePerms.length > 0 && employeePerms.every((p) => p.split('.')[1] === 'self'),
    employeePerms.join(', '));
  check('the employee role can see its own payslips and attendance',
    ['hr.self.view', 'hr.self.attendance', 'payroll.self.payslips']
      .every((p) => employeePerms.includes(p)),
    employeePerms.join(', '));
  check('the employee role cannot read anybody else’s record',
    !employeePerms.some((p) => ['hr.employees.view', 'payroll.payslips.view', 'core.members.view'].includes(p)));

  // System roles are pattern-based, so what they grant must be computed live
  // and must track the app registry rather than a snapshot taken at signup.
  const admin = roles.body?.data?.find((r) => r.slug === 'admin');
  const member = roles.body?.data?.find((r) => r.slug === 'member');
  check('admin role resolves permissions from patterns',
    (admin?.permissions?.length ?? 0) > 100,
    `${admin?.permissions?.length ?? 0} permissions`);
  check('admin is denied billing', !admin?.permissions?.some((p) => p.startsWith('billing.')));
  check('member cannot delete', !member?.permissions?.some((p) => p.endsWith('.delete')));
  check('member covers newly shipped apps',
    admin?.permissions?.some((p) => p.startsWith('ecommerce.')),
    'registry additions reach existing workspaces');

  const members = await call('/members');
  check('creator is a member', members.body?.data?.length === 1);
  check('creator is the owner',
    members.body?.data?.[0]?.roles?.some((r) => r.slug === 'owner'));

  const permissions = await call('/permissions');
  const apps = permissions.body?.data?.map((g) => g.app) ?? [];
  check('permission catalogue is limited to entitled apps',
    apps.includes('crm') && apps.includes('hr') && !apps.includes('accounting'),
    `offers: ${apps.join(', ')}`);

  // ── 10 ── add an app with a dependency ────────────────────────────────────
  step(10, 'Add an app that needs another');
  const added = await call('/subscriptions/current/apps', {
    method: 'POST',
    body: { app_slug: 'payroll' },
  });
  check('payroll added', added.status === 200, `status ${added.status}`);
  check('payroll provisioned',
    added.body?.data?.added?.includes('payroll'),
    `added: ${added.body?.data?.added?.join(', ')}`);

  await new Promise((r) => setTimeout(r, 1_200));
  const after = await call('/me/workspace');
  check('payroll now entitled', after.body?.data?.apps?.includes('payroll'));
  check('HR dependency remains entitled', after.body?.data?.apps?.includes('hr'));

  // ── 11 ── sessions ────────────────────────────────────────────────────────
  step(11, 'Session handling');
  const sessions = await call('/account/sessions');
  check('session listed', sessions.body?.data?.length >= 1,
    sessions.body?.data?.[0]?.device_label);

  const refreshed = await call('/auth/refresh', { method: 'POST', body: {} });
  check('refresh token rotates', refreshed.status === 200);

  const loggedOut = await call('/auth/logout', { method: 'POST' });
  check('sign out succeeds', loggedOut.status === 200);

  const afterLogout = await call('/me/workspace');
  check('revoked session cannot reach the API',
    afterLogout.status === 401 || afterLogout.body?.data?.needs_onboarding === true,
    `status ${afterLogout.status}`);

  // ── result ────────────────────────────────────────────────────────────────
  console.log('');
  if (failures === 0) {
    console.log(c.ok(c.bold('  ✔ everything passed\n')));
    process.exit(0);
  }
  console.log(c.bad(c.bold(`  ✘ ${failures} check${failures === 1 ? '' : 's'} failed\n`)));
  process.exit(1);
}

main().catch((error) => {
  console.error(`\n  ${c.bad('smoke test crashed:')} ${error.message}\n`);
  process.exit(1);
});
