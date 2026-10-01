import { test } from 'node:test';
import assert from 'node:assert/strict';
import { password, session, workspace, ok } from './helpers.js';

async function join(owner, role, email) {
  const roles = ok(await owner.call('/roles'));
  const invitation = ok(await owner.call('/invitations', 'POST', { email, role_ids: [roles.find((r) => r.slug === role).id] }), 201);
  const client = session();
  ok(await client.call('/auth/register', 'POST', { email, password, name: `Nexus ${role}`, invitation_token: new URL(invitation.invite_link).searchParams.get('token') }), 201);
  return { client, userId: ok(await client.call('/me/workspace')).user.id };
}

test('Workspace people and HR employees stay one list', async (t) => {
  const { client: owner, stamp, email: ownerEmail } = await workspace(['hr', 'tasks']);
  const ownerId = ok(await owner.call('/me/workspace')).user.id;
  const employees = async () => ok(await owner.call('/hr/employees?limit=100'));

  await t.test('the owner adds themselves and gets their own portal', async () => {
    assert.equal((await owner.call('/hr/me')).status, 403, 'not an employee yet');
    const people = ok(await owner.call('/hr/employees/workspace-people'));
    assert.ok(people.some((p) => p.user_id === ownerId && p.email === ownerEmail));
    const added = ok(await owner.call('/hr/employees/from-people', 'POST', { user_ids: [ownerId] }), 201);
    assert.equal(added.created, 1);
    const me = ok(await owner.call('/hr/me'));
    assert.equal(me.employee?.email ?? me.email, ownerEmail);
    assert.ok(!ok(await owner.call('/hr/employees/workspace-people')).some((p) => p.user_id === ownerId));
  });

  await t.test('a member who joined is listed to add; a guest is not', async () => {
    const memberEmail = `member-${stamp}@nexus.test`;
    const { userId } = await join(owner, 'member', memberEmail);
    await join(owner, 'guest', `guest-${stamp}@nexus.test`);
    // The join event may already have added them; either way they end up an employee, once.
    const waiting = ok(await owner.call('/hr/employees/workspace-people'));
    assert.ok(!waiting.some((p) => p.email === `guest-${stamp}@nexus.test`), 'guests are never offered');
    if (waiting.some((p) => p.user_id === userId)) ok(await owner.call('/hr/employees/from-people', 'POST', { user_ids: [userId] }), 201);
    const added = (await employees()).filter((e) => e.email === memberEmail);
    assert.equal(added.length, 1);
    assert.equal(added[0].user_id, userId);
    assert.equal(added[0].portal_status, 'active');
  });

  await t.test('an employee HR created first is linked, not duplicated', async () => {
    const email = `vaibhav-${stamp}@nexus.test`;
    const record = ok(await owner.call('/hr/employees', 'POST', { first_name: 'Vaibhav', last_name: 'Vyas', email }), 201);
    const { userId } = await join(owner, 'member', email);
    // Whether the join event got there first or not, adding them links the record HR already had.
    ok(await owner.call('/hr/employees/from-people', 'POST', { user_ids: [userId] }), 201);
    const linked = (await employees()).find((e) => e.id === record.id);
    assert.equal(linked?.user_id, userId);
    assert.equal((await employees()).filter((e) => e.email === email).length, 1);
  });

  await t.test('only people who manage HR can add others', async () => {
    const { client: guest } = await join(owner, 'guest', `other-${stamp}@nexus.test`);
    assert.equal((await guest.call('/hr/employees/from-people', 'POST', { user_ids: [ownerId] })).status, 403);
  });
});
