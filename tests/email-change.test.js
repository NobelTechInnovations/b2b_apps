import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emailChangeFixture, password } from './lib/email-change-fixture.js';
import { consumeCurrentEmailToken } from '../services/identity/src/lib/email-tokens.js';
import { createEmailSender } from '../services/notifier/src/lib/email.js';

test('email changes keep identity and workspace links intact', async (t) => {
  const f = await emailChangeFixture();
  t.after(() => f.close());
  const owner = await f.user('owner@nexus.test');
  const employee = await f.user('employee@nexus.test');
  const admin = await f.user('admin@nexus.test');
  const org = await f.organization(owner);
  await f.member(org, owner, 'owner');
  await f.member(org, admin, 'admin');
  const employeeMemberId = await f.member(org, employee);
  const request = (actor, email, target) => f.call('/auth/change-email', { actor, org,
    payload: { email, current_password: password, ...(target ? { user_id: target.id } : {}) } });
  const confirm = (token) => f.call('/auth/confirm-email-change', { payload: { token } });
  const expectStatus = (response, status) => assert.equal(response.statusCode, status, response.body);

  await t.test('anonymous, malformed, same-address and incorrect-password requests are rejected', async () => {
    expectStatus(await request(null, 'next@nexus.test'), 401);
    expectStatus(await request(employee, 'not-email'), 400);
    expectStatus(await request(employee, 'EMPLOYEE@nexus.test'), 400);
    expectStatus(await f.call('/auth/change-email', { actor: employee, org, payload: { email: 'next@nexus.test', current_password: 'wrong' } }), 400);
    assert.equal((await f.db.one(`SELECT count(*)::int AS n FROM email_change_requests`)).n, 0);
  });

  await t.test('duplicate addresses are case insensitive', async () => {
    expectStatus(await request(employee, 'OWNER@nexus.test'), 409);
  });

  await t.test('request leaves login unchanged, queues mail to both addresses and stores only a token hash', async () => {
    expectStatus(await request(employee, 'NEXT@nexus.test'), 200);
    const record = await f.db.one(`SELECT * FROM email_change_requests WHERE user_id = $1 AND consumed_at IS NULL`, [employee.id]);
    assert.equal(record.new_email, 'next@nexus.test');
    assert.notEqual(record.token_hash, await f.tokenFor(employee.id));
    assert.equal((await f.db.one(`SELECT email FROM users WHERE id = $1`, [employee.id])).email, employee.email);
    const pending = await f.call('/auth/email-change', { method: 'GET', actor: employee });
    expectStatus(pending, 200);
    assert.equal(pending.json().data.new_email, 'next@nexus.test');
    assert.equal(pending.headers['cache-control'], 'no-store');
    assert.equal((await f.db.rows(`SELECT data FROM outbox WHERE data->>'template' = 'email_change_requested'`)).length, 1);
  });

  await t.test('resend invalidates the previous link; cancellation invalidates the latest link', async () => {
    const old = await f.tokenFor(employee.id);
    expectStatus(await request(employee, 'replacement@nexus.test'), 200);
    expectStatus(await confirm(old), 400);
    const latest = await f.tokenFor(employee.id);
    expectStatus(await f.call('/auth/cancel-email-change', { actor: employee, payload: {} }), 200);
    expectStatus(await confirm(latest), 400);
  });

  await t.test('expired and unknown links do not update users', async () => {
    expectStatus(await request(employee, 'expired@nexus.test'), 200);
    const token = await f.tokenFor(employee.id);
    await f.db.query(`UPDATE email_change_requests SET expires_at = now() - interval '1 minute' WHERE user_id = $1`, [employee.id]);
    expectStatus(await confirm(token), 400);
    expectStatus(await confirm('unknown-token'), 400);
  });

  await t.test('address claimed after request is rejected at confirmation', async () => {
    expectStatus(await request(employee, 'claimed@nexus.test'), 200);
    const token = await f.tokenFor(employee.id);
    await f.user('claimed@nexus.test');
    expectStatus(await confirm(token), 409);
    assert.equal((await f.db.one(`SELECT email FROM users WHERE id = $1`, [employee.id])).email, employee.email);
  });

  await t.test('confirmation preserves IDs and permissions, revokes sessions and recovery links, and permits new-email login', async () => {
    const before = await f.tenancyDb.rows(`SELECT * FROM member_roles WHERE member_id = $1`, [employeeMemberId]);
    const login = await f.call('/auth/login', { payload: { email: employee.email, password } });
    expectStatus(login, 200);
    const reset = await f.recoveryToken(employee, 'reset_password');
    const verify = await f.recoveryToken(employee, 'verify_email');
    expectStatus(await request(employee, 'confirmed@nexus.test'), 200);
    const token = await f.tokenFor(employee.id);
    expectStatus(await confirm(token), 200);
    expectStatus(await confirm(token), 400);
    const user = await f.db.one(`SELECT * FROM users WHERE id = $1`, [employee.id]);
    assert.equal(user.email, 'confirmed@nexus.test');
    assert.ok(user.email_verified_at);
    assert.equal(user.password_hash, employee.password_hash);
    assert.deepEqual(await f.tenancyDb.rows(`SELECT * FROM member_roles WHERE member_id = $1`, [employeeMemberId]), before);
    assert.equal((await f.db.one(`SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL`, [employee.id])).n, 0);
    expectStatus(await f.call('/auth/reset-password', { payload: { token: reset.raw, password: 'Another-safe-passphrase-42!' } }), 400);
    expectStatus(await f.call('/auth/verify-email', { payload: { token: verify.raw } }), 400);
    await assert.rejects(f.db.transaction((tx) => consumeCurrentEmailToken(tx, reset.record)), /invalid or expired/);
    expectStatus(await f.call('/auth/login', { payload: { email: employee.email, password } }), 401);
    const newLogin = await f.call('/auth/login', { payload: { email: user.email, password } });
    expectStatus(newLogin, 200);
    assert.equal(newLogin.json().data.user.id, employee.id);
    assert.equal(newLogin.json().data.organization.id, org.id);
    assert.equal((await f.db.rows(`SELECT * FROM outbox WHERE type = 'identity.user.email_changed'`)).length, 1);
    assert.equal((await f.db.rows(`SELECT * FROM outbox WHERE type = 'identity.session.revoked'`)).length, 1);
  });

  await t.test('normal employees cannot request, read or cancel another account\'s email change', async () => {
    expectStatus(await request(employee, 'takeover@nexus.test', admin), 403);
    expectStatus(await f.call(`/auth/email-change?user_id=${admin.id}`, { method: 'GET', actor: employee, org }), 403);
    expectStatus(await f.call('/auth/cancel-email-change', { actor: employee, org, payload: { user_id: admin.id } }), 403);
  });

  await t.test('admins cannot change owners, another workspace\'s members, or multi-workspace accounts', async () => {
    expectStatus(await request(admin, 'takeowner@nexus.test', owner), 403);
    const otherOwner = await f.user('otherowner@nexus.test');
    const other = await f.organization(otherOwner);
    await f.member(other, otherOwner, 'owner');
    expectStatus(await request(admin, 'other@nexus.test', otherOwner), 403);
    const multiId = await f.member(other, employee);
    expectStatus(await request(admin, 'multi@nexus.test', employee), 403);
    await f.tenancyDb.query(`UPDATE members SET status = 'suspended' WHERE id = $1`, [multiId]);
    expectStatus(await request(admin, 'multi@nexus.test', employee), 403);
    await f.tenancyDb.query(`UPDATE members SET status = 'removed' WHERE id = $1`, [multiId]);
  });

  await t.test('admin authority is checked again at confirmation', async () => {
    expectStatus(await request(admin, 'adminrequested@nexus.test', employee), 200);
    const token = await f.tokenFor(employee.id);
    await f.tenancyDb.query(`UPDATE members SET status = 'suspended' WHERE user_id = $1`, [admin.id]);
    expectStatus(await confirm(token), 403);
    await f.tenancyDb.query(`UPDATE members SET status = 'active' WHERE user_id = $1`, [admin.id]);
    expectStatus(await confirm(token), 200);
    const event = await f.db.one(`SELECT actor_id FROM outbox WHERE type = 'identity.user.email_changed' ORDER BY created_at DESC LIMIT 1`);
    assert.equal(event.actor_id, admin.id);
  });

  await t.test('password changes cancel pending email changes', async () => {
    expectStatus(await request(admin, 'passwordcancel@nexus.test'), 200);
    const token = await f.tokenFor(admin.id);
    expectStatus(await f.call('/auth/change-password', { actor: admin, payload: { current_password: password, new_password: 'Replaced-passphrase-42!' } }), 200);
    expectStatus(await confirm(token), 400);
  });

  await t.test('a suspended initiating account cannot complete its pending change', async () => {
    expectStatus(await request(owner, 'suspended@nexus.test'), 200);
    const token = await f.tokenFor(owner.id);
    await f.db.query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [owner.id]);
    expectStatus(await confirm(token), 400);
  });

  await t.test('verification and password reset still work and tokens remain single-use', async () => {
    const person = await f.user('recovery@nexus.test');
    const verify = await f.recoveryToken(person, 'verify_email');
    expectStatus(await f.call('/auth/verify-email', { payload: { token: verify.raw } }), 200);
    expectStatus(await f.call('/auth/verify-email', { payload: { token: verify.raw } }), 400);
    expectStatus(await request(person, 'recoverynew@nexus.test'), 200);
    const change = await f.tokenFor(person.id);
    const reset = await f.recoveryToken(person, 'reset_password');
    expectStatus(await f.call('/auth/reset-password', { payload: { token: reset.raw, password: 'Another-safe-passphrase-42!' } }), 200);
    expectStatus(await confirm(change), 400);
    expectStatus(await f.call('/auth/reset-password', { payload: { token: reset.raw, password: 'Another-safe-passphrase-42!' } }), 400);
  });

  await t.test('a failed outbox write rolls back the email, tokens and session revocation together', async () => {
    const person = await f.user('rollback@nexus.test');
    expectStatus(await f.call('/auth/login', { payload: { email: person.email, password } }), 200);
    expectStatus(await request(person, 'rollbacknew@nexus.test'), 200);
    const token = await f.tokenFor(person.id);
    await f.db.query(`CREATE FUNCTION reject_email_event() RETURNS trigger AS $$ BEGIN
      IF NEW.type = 'identity.user.email_changed' THEN RAISE EXCEPTION 'test outbox failure'; END IF;
      RETURN NEW; END; $$ LANGUAGE plpgsql`);
    await f.db.query(`CREATE TRIGGER reject_email_event BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION reject_email_event()`);
    try {
      expectStatus(await confirm(token), 500);
      assert.equal((await f.db.one(`SELECT email FROM users WHERE id = $1`, [person.id])).email, person.email);
      assert.equal((await f.db.one(`SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL`, [person.id])).n, 1);
      assert.ok(await f.db.one(`SELECT id FROM email_change_requests WHERE user_id = $1 AND consumed_at IS NULL`, [person.id]));
    } finally {
      await f.db.query(`DROP TRIGGER reject_email_event ON outbox`);
    }
    expectStatus(await confirm(token), 200);
  });
});

test('email-change password attempts are rate limited', async (t) => {
  const f = await emailChangeFixture({ rateLimit: true });
  t.after(() => f.close());
  const user = await f.user('ratelimit@nexus.test');
  for (let n = 0; n < 6; n++) {
    const response = await f.call('/auth/change-email', { actor: user, payload: { email: 'next@nexus.test', current_password: 'wrong' } });
    assert.equal(response.statusCode, n === 5 ? 429 : 400, response.body);
  }
});

test('notifier renders every email-change template', async () => {
  const messages = [];
  const sender = createEmailSender({ config: {}, logger: { info() {}, warn() {} },
    db: { one: async (_sql, values) => { messages.push(values); return { id: 'email-test', attempts: 1 }; } },
  });
  for (const template of ['change_email', 'email_change_requested', 'email_changed']) {
    const result = await sender.send({ eventId: template, to: 'person@nexus.test', template,
      data: { name: 'Test Person', new_email: 'new@nexus.test', by_admin: true, link: 'https://app.example/confirm-email-change?token=test-token' },
    });
    assert.equal(result.status, 'logged');
  }
  assert.deepEqual(messages.map((values) => values[3]), ['change_email', 'email_change_requested', 'email_changed']);
  assert.deepEqual(messages.map((values) => values[6]), [
    'Confirm your new sign-in email', 'An email change was requested for your account', 'Your sign-in email has changed',
  ]);
});
