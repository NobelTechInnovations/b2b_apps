import { test } from 'node:test';
import assert from 'node:assert/strict';
import { API, password, session, workspace, invite, ok } from './helpers.js';

const APPS = ['crm', 'leads', 'tasks', 'surveys'];
const publicCall = async (path, method = 'GET', body, headers = { 'content-type': 'application/json' }) => {
  const response = await fetch(`${API}/api${path}`, {
    method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  return { status: response.status, ...(text && text.startsWith('{') ? JSON.parse(text) : { text }) };
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Invite with a chosen set of apps, the way the People screen does. */
async function inviteWithApps(owner, role, stamp, appAccess) {
  const roles = ok(await owner.call('/roles'));
  const email = `${role}-${stamp}@nexus.test`;
  const client = session();
  const invitation = ok(await owner.call('/invitations', 'POST', { email, role_ids: [roles.find((r) => r.slug === role).id], app_access: appAccess }), 201);
  const token = new URL(invitation.invite_link).searchParams.get('token');
  ok(await client.call('/auth/register', 'POST', { email, password, name: `Caller ${role}`, invitation_token: token }), 201);
  return { client, email };
}

async function waitFor(fn, { timeout = 15000, every = 500 } = {}) {
  const until = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value || Date.now() > until) return value;
    await sleep(every);
  }
}

test('App access: people open only the apps they were given', async (t) => {
  const { client: owner, stamp } = await workspace(APPS);
  const { client: caller, email } = await inviteWithApps(owner, 'member', `${stamp}-caller`, ['tasks']);
  const members = ok(await owner.call('/members'));
  const member = members.find((m) => m.email === email);

  await t.test('an invitation can limit someone to Boards', async () => {
    assert.deepEqual(member.app_access, ['tasks']);
    const ws = ok(await caller.call('/me/workspace'));
    assert.ok(ws.apps.includes('tasks'));
    assert.ok(!ws.apps.includes('crm') && !ws.apps.includes('leads'), 'CRM and Leads are hidden');
    assert.ok(ws.workspace_apps.includes('crm'), 'the workspace still has CRM');
    assert.ok(!ws.navigation.some((n) => n.slug === 'crm'));
    const refused = await caller.call('/crm/leads');
    assert.equal(refused.status, 403);
    assert.equal(refused.error.code, 'app_not_assigned');
    assert.equal((await caller.call('/leads/leads')).status, 403);
  });

  await t.test('an owner shares one more app; nothing else opens', async () => {
    assert.equal((await caller.call(`/members/${member.id}/apps`, 'PUT', { app_access: null })).status, 403, 'members cannot widen their own access');
    assert.equal((await owner.call(`/members/${member.id}/apps`, 'PUT', { app_access: ['leads', 'nonsense'] })).status, 400);
    const updated = ok(await owner.call(`/members/${member.id}/apps`, 'PUT', { app_access: ['leads', 'tasks'] }));
    assert.deepEqual(updated.app_access, ['leads', 'tasks']);
    ok(await caller.call('/leads/leads'));
    assert.equal((await caller.call('/crm/leads')).status, 403);
    const ws = ok(await caller.call('/me/workspace'));
    assert.ok(ws.navigation.some((n) => n.slug === 'leads'));
    assert.ok(!ws.permissions.some((p) => p.startsWith('crm.')), 'no CRM permissions travel');
  });

  await t.test('“every app” and administrators are never limited', async () => {
    ok(await owner.call(`/members/${member.id}/apps`, 'PUT', { app_access: null }));
    ok(await caller.call('/crm/leads'));
    const admin = await inviteWithApps(owner, 'admin', `${stamp}-admin`, ['tasks']);
    ok(await admin.client.call('/crm/leads'), 200);
  });
});

test('Leads: fields, calls, follow-ups, ownership and reminders', async (t) => {
  const { client: owner, stamp } = await workspace(APPS);
  const { client: rep } = await inviteWithApps(owner, 'member', `${stamp}-rep`, ['leads', 'tasks']);
  const ownerId = ok(await owner.call('/me/workspace')).user.id;
  const repId = ok(await rep.call('/me/workspace')).user.id;
  let meta, lead, villa;

  await t.test('a workspace starts with stages and adds its own fields', async () => {
    meta = ok(await owner.call('/leads/meta'));
    assert.deepEqual(meta.stages.map((s) => s.name), ['New', 'Contacted', 'Interested', 'Negotiation', 'Won', 'Lost']);
    assert.ok(meta.team.some((p) => p.user_id === repId));
    assert.equal(meta.sees_all, true);
    assert.equal(ok(await rep.call('/leads/meta')).sees_all, false);
    ok(await owner.call('/leads/fields', 'POST', { label: 'Budget', type: 'number' }), 201);
    villa = ok(await owner.call('/leads/fields', 'POST', { label: 'Property type', type: 'select', options: ['Flat', 'Villa', 'Plot'], required: true }), 201);
    assert.equal(villa.key, 'property_type');
    assert.equal((await owner.call('/leads/fields', 'POST', { label: 'Kind', type: 'select' })).status, 400, 'a list needs options');
    assert.equal((await rep.call('/leads/fields', 'POST', { label: 'Mine', type: 'text' })).status, 403);
  });

  await t.test('a lead needs its required fields, valid options, and no twin', async () => {
    const bad = await rep.call('/leads/leads', 'POST', { full_name: 'Ravi Kumar', phone: '+91 98765 43210', custom: { property_type: 'Castle' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.error.details[0].field, 'custom.property_type');
    lead = ok(await rep.call('/leads/leads', 'POST', {
      full_name: 'Ravi Kumar', phone: '+91 98765 43210', city: 'Pune', source: 'walk_in',
      custom: { budget: '50,00,000', property_type: 'villa' },
    }), 201);
    assert.equal(lead.name, 'Ravi Kumar');
    assert.equal(lead.owner_user_id, repId, 'the creator owns it');
    assert.equal(lead.custom.budget, 5000000);
    assert.equal(lead.custom.property_type, 'Villa');
    assert.ok(lead.stage_id, 'placed in the first stage');
    const twin = await rep.call('/leads/leads', 'POST', { full_name: 'R Kumar', phone: '09876543210', custom: { property_type: 'Flat' } });
    assert.equal(twin.status, 409);
    assert.equal(twin.error.details.lead_id, lead.id);
    ok(await rep.call('/leads/leads', 'POST', { full_name: 'R Kumar', phone: '09876543210', custom: { property_type: 'Flat' }, allow_duplicate: true }), 201);
    assert.equal((await rep.call('/leads/leads', 'POST', { full_name: 'X', phone: '9000000001', owner_user_id: ownerId, custom: { property_type: 'Flat' } })).status, 403, 'members cannot hand leads to others');
  });

  await t.test('a call update logs the outcome, moves the stage and books the next follow-up', async () => {
    const interested = meta.stages.find((s) => s.name === 'Interested');
    const due = new Date(Date.now() + 2 * 3600_000).toISOString();
    const after = ok(await rep.call(`/leads/leads/${lead.id}/calls`, 'POST', {
      outcome: 'call_back', note: 'Wants a site visit on Sunday', duration_minutes: 4, stage_id: interested.id,
      followup: { due_at: due, kind: 'call', note: 'Confirm Sunday' },
    }));
    assert.equal(after.call_count, 1);
    assert.equal(after.last_call_outcome, 'call_back');
    assert.equal(after.stage_id, interested.id);
    assert.equal(after.status, 'contacted');
    assert.equal(new Date(after.next_followup_at).toISOString(), due);
    const detail = ok(await rep.call(`/leads/leads/${lead.id}`));
    assert.equal(detail.followups.length, 1);
    assert.ok(detail.timeline.some((a) => a.kind === 'call' && a.outcome === 'call_back' && a.body === 'Wants a site visit on Sunday'));
    assert.ok(detail.timeline.some((a) => a.subject === 'Moved to Interested from New'));
    const found = ok(await rep.call('/leads/leads?q=98765&outcome=call_back'));
    assert.ok(found.some((l) => l.id === lead.id), 'found by phone digits');
    const lists = await Promise.all(['today', 'upcoming'].map(async (bucket) => ok(await rep.call(`/leads/followups?bucket=${bucket}&tz=Asia/Kolkata`))));
    assert.ok(lists.flat().some((f) => f.related_id === lead.id && f.lead_name === 'Ravi Kumar'));
  });

  await t.test('people see their own leads; owners see everyone’s and hand them out', async () => {
    const mine = ok(await owner.call('/leads/leads', 'POST', { full_name: 'Meera Shah', email: 'meera@example.com', custom: { property_type: 'Plot' } }), 201);
    assert.ok(!ok(await rep.call('/leads/leads')).some((l) => l.id === mine.id));
    assert.equal((await rep.call(`/leads/leads/${mine.id}`)).status, 404);
    assert.ok(ok(await owner.call('/leads/leads')).some((l) => l.id === lead.id), 'owners see the rep’s lead');
    assert.equal((await rep.call(`/leads/leads/${mine.id}`, 'PATCH', { owner_user_id: repId })).status, 404, 'nobody takes a lead that is not theirs');
    const moved = ok(await owner.call(`/leads/leads/${mine.id}`, 'PATCH', { owner_user_id: repId }));
    assert.equal(moved.owner.user_id, repId);
    ok(await rep.call(`/leads/leads/${mine.id}`));
    const note = await waitFor(async () => ok(await rep.call('/notifications')).find((n) => n.kind === 'leads.assigned'));
    assert.ok(note, 'the rep is told about the new lead');
    assert.match(note.title, /Meera Shah/);
  });

  await t.test('a follow-up due now reminds its owner once', { timeout: 120_000 }, async () => {
    const soon = ok(await rep.call(`/leads/leads/${lead.id}/followups`, 'POST', { due_at: new Date(Date.now() + 60_000).toISOString(), kind: 'whatsapp' }), 201);
    const reminder = await waitFor(async () => ok(await rep.call('/notifications')).find((n) => n.kind === 'leads.followup_due'), { timeout: 100_000, every: 3000 });
    assert.ok(reminder, 'reminded within the minute');
    assert.match(reminder.title, /^WhatsApp Ravi Kumar at /);
    ok(await rep.call(`/leads/followups/${soon.id}/done`, 'POST', { note: 'Sent the brochure' }));
    assert.equal((await rep.call(`/leads/followups/${soon.id}/done`, 'POST', {})).status, 400, 'already closed');
  });

  await t.test('stages: add one, lose a lead, retire a stage', async () => {
    const visit = ok(await owner.call('/leads/stages', 'POST', { name: 'Site visit', color: 'teal' }), 201);
    const stages = ok(await owner.call('/leads/stages'));
    assert.deepEqual(stages.map((s) => s.name), ['New', 'Contacted', 'Interested', 'Negotiation', 'Site visit', 'Won', 'Lost']);
    assert.equal((await owner.call('/leads/stages', 'POST', { name: 'site VISIT' })).status, 400, 'names are unique');
    const lost = stages.find((s) => s.name === 'Lost');
    ok(await owner.call('/leads/leads/bulk', 'POST', { ids: [lead.id], action: 'stage', stage_id: lost.id }));
    assert.equal(ok(await owner.call(`/leads/leads/${lead.id}`)).status, 'unqualified', 'CRM sees it as unqualified');
    ok(await owner.call(`/leads/leads/${lead.id}`, 'PATCH', { stage_id: visit.id }));
    assert.equal((await owner.call(`/leads/stages/${visit.id}`, 'DELETE', { move_to: visit.id })).status, 400);
    ok(await owner.call(`/leads/stages/${visit.id}`, 'DELETE', { move_to: stages.find((s) => s.name === 'Interested').id }));
    assert.equal(ok(await owner.call(`/leads/leads/${lead.id}`)).stage.name, 'Interested');
  });

  await t.test('the dashboard tiles count today', async () => {
    const tiles = ok(await rep.call('/leads/widgets'));
    assert.ok(tiles['leads.followups_today'] >= 0);
    assert.ok(tiles['leads.new_today'] >= 2);
  });
});

test('Leads: CSV import, sheets, webhooks and survey forms', async (t) => {
  const { client: owner, stamp } = await workspace(APPS);
  const { client: rep } = await inviteWithApps(owner, 'member', `${stamp}-rep`, ['leads']);
  const ownerId = ok(await owner.call('/me/workspace')).user.id;
  const repId = ok(await rep.call('/me/workspace')).user.id;
  ok(await owner.call('/leads/fields', 'POST', { label: 'Budget', type: 'number' }), 201);
  ok(await owner.call('/leads/leads', 'POST', { full_name: 'Existing Person', phone: '9811111111' }), 201);

  await t.test('a CSV is matched to fields, deduplicated and shared round-robin', async () => {
    const csv = [
      '﻿Name,Mobile No.,Email,City,Budget,Remarks,Agent notes',
      'Asha Verma,98222 22222,asha@example.com,Delhi,"12,00,000","Wants 2BHK, east facing",x',
      'Vikram Rao,+91 9833333333,,Mumbai,900000,Call after 6pm,',
      'Copy Of Asha,9822222222,,Delhi,,,',
      'Existing Again,09811111111,,,,,',
      ',,,,,,only notes',
      'Neha Jain,9844444444,neha@example.com,Pune,abc,,',
    ].join('\r\n');
    const preview = ok(await owner.call('/leads/import/preview', 'POST', { csv }));
    assert.equal(preview.total, 6);
    assert.deepEqual(preview.mapping, { Name: 'full_name', 'Mobile No.': 'phone', Email: 'email', City: 'city', Budget: 'custom.budget', Remarks: 'notes' });
    assert.equal((await rep.call('/leads/import/preview', 'POST', { csv })).status, 403, 'members cannot import');
    const result = ok(await owner.call('/leads/import', 'POST', {
      csv, name: 'Expo visitors', mapping: { ...preview.mapping, 'Agent notes': 'skip' }, assign_to: [ownerId, repId], tags: ['expo'],
    }), 201);
    assert.deepEqual({ created: result.created, duplicates: result.duplicates, failed: result.failed }, { created: 3, duplicates: 2, failed: 1 });
    const leads = ok(await owner.call('/leads/leads?tag=expo&limit=100'));
    assert.equal(leads.length, 3);
    assert.deepEqual(new Set(leads.map((l) => l.owner_user_id)), new Set([ownerId, repId]), 'shared between both');
    const asha = leads.find((l) => l.name === 'Asha Verma');
    assert.equal(asha.custom.budget, 1200000);
    assert.equal(asha.city, 'Delhi');
    assert.equal(asha.source, 'import');
    assert.equal(asha.source_detail, 'CSV · Expo visitors');
    const neha = leads.find((l) => l.name === 'Neha Jain');
    assert.match(neha.notes, /Budget: abc/, 'a value that does not fit is kept in the notes');
    const history = ok(await owner.call('/leads/imports'));
    assert.equal(history[0].created, 3);
  });

  await t.test('only Google Sheets links are fetched', async () => {
    for (const sheet_url of ['http://localhost:4000/api/health', 'https://evil.example.com/spreadsheets/d/abc', 'https://docs.google.com/document/d/abc']) {
      assert.equal((await owner.call('/leads/import/preview', 'POST', { sheet_url })).status, 400, sheet_url);
    }
  });

  await t.test('a webhook source takes JSON, forms and IndiaMART pushes', async () => {
    const source = ok(await owner.call('/leads/sources', 'POST', { kind: 'webhook', name: 'Website', assign_to: [repId] }), 201);
    assert.match(source.webhook_url, /\/api\/lead-hooks\/in\/[A-Za-z0-9_-]{20,}$/);
    const path = new URL(source.webhook_url).pathname.replace(/^\/api/, '');
    const first = await publicCall(path, 'POST', { name: 'Imran Khan', phone: '9855555555', email: 'imran@example.com', message: 'Price list please', budget: '700000' });
    assert.equal(first.status, 201);
    assert.equal(first.created, 1);
    const again = await publicCall(path, 'POST', { name: 'Imran K', phone: '+91 98555 55555', message: 'Any discount?' });
    assert.equal(again.duplicates, 1);
    const imran = ok(await rep.call('/leads/leads?q=Imran'))[0];
    assert.equal(imran.owner_user_id, repId);
    assert.equal(imran.custom.budget, 700000);
    assert.ok(ok(await rep.call(`/leads/leads/${imran.id}`)).timeline.some((a) => a.subject.startsWith('Enquired again')));
    const india = { RESPONSE: { UNIQUE_QUERY_ID: '2918273645', SENDER_NAME: 'Suresh Patel', SENDER_MOBILE: '+91-9866666666', SENDER_CITY: 'Surat', QUERY_MESSAGE: 'Need 500 units' } };
    assert.equal((await publicCall(path, 'POST', india)).created, 1);
    assert.equal((await publicCall(path, 'POST', india)).duplicates, 1);
    const form = await publicCall(path, 'POST', 'name=Tara+Singh&phone=9877777777', { 'content-type': 'application/x-www-form-urlencoded' });
    assert.equal(form.created, 1);
    const suresh = ok(await owner.call('/leads/leads?q=Suresh'))[0];
    assert.equal(suresh.city, 'Surat');
    assert.equal(suresh.source, 'webhook');
    const rotated = ok(await owner.call(`/leads/sources/${source.id}/rotate`, 'POST', {}));
    assert.notEqual(rotated.webhook_url, source.webhook_url);
    assert.equal((await publicCall(path, 'POST', { name: 'Late' })).status, 404, 'the old link is dead');
    const listed = ok(await owner.call('/leads/sources'));
    assert.equal(listed.find((s) => s.id === source.id).lead_count, 3);
    assert.ok(!('secret' in listed[0]) && !('token' in listed[0]));
  });

  await t.test('Meta calls must be signed', async () => {
    assert.equal((await publicCall('/lead-hooks/meta', 'POST', { entry: [] })).status, 401);
    assert.equal((await publicCall('/lead-hooks/meta?hub.mode=subscribe&hub.verify_token=guess&hub.challenge=1')).status, 403);
  });

  await t.test('a published survey takes answers without an account and files a lead', async () => {
    const created = ok(await owner.call('/surveys/forms', 'POST', {
      name: 'Home loan enquiry', create_lead: true,
      fields: [
        { key: 'name', label: 'Name', type: 'short_text', required: true, maps_to: 'full_name' },
        { key: 'mobile', label: 'Mobile', type: 'phone', required: true, maps_to: 'phone' },
        { key: 'budget', label: 'Budget', type: 'number', maps_to: 'custom.budget' },
        { key: 'when', label: 'When do you plan to buy?', type: 'select', options: ['This month', 'Later'] },
      ],
    }), 201);
    ok(await owner.call(`/surveys/forms/${created.id}`, 'PATCH', { status: 'published' }));
    const view = await publicCall(`/public-forms/${created.public_token}`);
    assert.equal(view.status, 200);
    assert.equal(view.data.open, true);
    const sent = await publicCall(`/public-forms/${created.public_token}/submit`, 'POST', { answers: { name: 'Pooja Nair', mobile: '9888888888', budget: '2500000', when: 'Later' } });
    assert.equal(sent.status, 201);
    const pooja = ok(await owner.call('/leads/leads?q=Pooja'))[0];
    assert.equal(pooja.custom.budget, 2500000);
    assert.equal(pooja.source_detail, 'Form · Home loan enquiry');
    assert.match(pooja.notes, /When do you plan to buy\?: Later/);
  });
});

test('Leads: handing over, grouping, CRM visibility and app access for employees', async (t) => {
  const { client: owner, stamp } = await workspace(APPS);
  const { client: asha } = await inviteWithApps(owner, 'member', `${stamp}-asha`, ['leads', 'crm']);
  const { client: vikram } = await inviteWithApps(owner, 'member', `${stamp}-vikram`, ['leads']);
  const ashaId = ok(await asha.call('/me/workspace')).user.id;
  const vikramId = ok(await vikram.call('/me/workspace')).user.id;
  let first, second;

  await t.test('a caller hands their own lead to a teammate, and it leaves their list', async () => {
    first = ok(await asha.call('/leads/leads', 'POST', { full_name: 'Gopal Rao', phone: '9810000001' }), 201);
    second = ok(await asha.call('/leads/leads', 'POST', { full_name: 'Farah Ali', phone: '9810000002' }), 201);
    assert.equal(ok(await vikram.call('/leads/leads?stage_kind=open')).length, 0, 'nothing is shared until it is handed over');
    ok(await asha.call(`/leads/leads/${first.id}/followups`, 'POST', { due_at: new Date(Date.now() + 86_400_000).toISOString(), kind: 'call' }), 201);
    assert.equal((await asha.call(`/leads/leads/${first.id}`, 'PATCH', { owner_user_id: null })).status, 400, 'members cannot leave a lead unassigned');
    const moved = ok(await asha.call(`/leads/leads/${first.id}`, 'PATCH', { owner_user_id: vikramId }));
    assert.deepEqual(moved, { id: first.id, owner_user_id: vikramId, handed_over: true });
    assert.equal((await asha.call(`/leads/leads/${first.id}`)).status, 404);
    const theirs = ok(await vikram.call(`/leads/leads/${first.id}`));
    assert.equal(theirs.owner_user_id, vikramId);
    assert.equal(theirs.followups[0].assigned_to, vikramId, 'the follow-up goes with it');
    assert.ok(theirs.timeline.some((a) => a.subject === 'Handed over to Caller member' || a.subject.startsWith('Handed over to')));
    assert.equal((await vikram.call(`/leads/leads/${second.id}`, 'PATCH', { owner_user_id: vikramId })).status, 404);
    const note = await waitFor(async () => ok(await vikram.call('/notifications')).find((n) => n.kind === 'leads.assigned'));
    assert.match(note.title, /Gopal Rao was handed over to you/);
    assert.match(note.body, /^Handed over by /);
  });

  await t.test('in bulk too, and a manager can hand them back', async () => {
    assert.equal(ok(await asha.call('/leads/leads/bulk', 'POST', { ids: [second.id, first.id], action: 'assign', owner_user_id: vikramId })).changed, 1, 'only her own lead moves');
    assert.equal(ok(await vikram.call('/leads/leads')).length, 2);
    ok(await owner.call('/leads/leads/bulk', 'POST', { ids: [first.id, second.id], action: 'assign', owner_user_id: ashaId }));
    assert.equal(ok(await asha.call('/leads/leads')).length, 2);
  });

  await t.test('leads group by stage, owner and follow-up', async () => {
    ok(await owner.call('/leads/leads', 'POST', { full_name: 'Owner Lead', phone: '9810000003', city: 'pune' }), 201);
    const byOwner = ok(await owner.call('/leads/groups?by=owner&stage_kind=open'));
    assert.equal(byOwner.find((g) => g.key === ashaId).count, 2);
    const byStage = ok(await owner.call('/leads/groups?by=stage'));
    assert.equal(byStage[0].label, 'New');
    assert.equal(byStage[0].count, 3);
    const byCity = ok(await owner.call('/leads/groups?by=city'));
    assert.ok(byCity.some((g) => g.label === 'Pune' && g.count === 1));
    assert.ok(byCity.some((g) => g.key === 'none' && g.count === 2));
    const inGroup = ok(await owner.call(`/leads/leads?${new URLSearchParams(byCity.find((g) => g.key === 'none').filter)}`));
    assert.equal(inGroup.length, 2);
    const followups = ok(await asha.call('/leads/groups?by=followup&tz=Asia/Kolkata'));
    assert.ok(followups.every((g) => ['overdue', 'today', 'upcoming', 'none'].includes(g.key)));
    assert.equal(ok(await asha.call('/leads/groups?by=owner')).length, 1, 'a caller only ever sees their own group');
  });

  await t.test('CRM shows people their own leads; owners see all', async () => {
    const boss = ok(await owner.call('/crm/leads', 'POST', { first_name: 'Boss', last_name: 'Lead', email: 'boss-lead@example.com' }), 201);
    const hers = ok(await asha.call('/crm/leads', 'POST', { first_name: 'Her', last_name: 'Lead' }), 201);
    const list = ok(await asha.call('/crm/leads?limit=100'));
    assert.ok(list.some((l) => l.id === hers.id));
    assert.ok(!list.some((l) => l.id === boss.id));
    assert.equal((await asha.call(`/crm/leads/${boss.id}`)).status, 404);
    assert.ok(ok(await owner.call('/crm/leads?limit=100')).some((l) => l.id === hers.id));
  });

  await t.test('sharing Leads with an Employee gives them working access', async () => {
    const { client: staff } = await inviteWithApps(owner, 'employee', `${stamp}-staff`, ['leads', 'tasks']);
    const ws = ok(await staff.call('/me/workspace'));
    assert.ok(ws.navigation.some((n) => n.slug === 'leads'), 'Leads appears for them');
    ok(await staff.call('/leads/leads'));
    ok(await staff.call('/leads/leads', 'POST', { full_name: 'Walk In', phone: '9810000004' }), 201);
    assert.equal((await staff.call('/leads/import/preview', 'POST', { csv: 'Name\nA' })).status, 403, 'still not a manager');
  });

  await t.test('changing someone’s apps does not sign anybody out', async () => {
    const members = ok(await owner.call('/members'));
    const vikramMember = members.find((m) => m.user_id === vikramId);
    const cookie = asha.cookie();
    ok(await owner.call(`/members/${vikramMember.id}/apps`, 'PUT', { app_access: ['leads', 'tasks'] }));
    const raw = await fetch(`${API}/api/leads/leads`, { headers: { cookie } });
    assert.equal(raw.status, 200, 'other people carry on without refreshing');
    const roles = ok(await owner.call('/roles'));
    ok(await owner.call(`/members/${members.find((m) => m.user_id === ashaId).id}/roles`, 'PUT', { role_ids: [roles.find((r) => r.slug === 'guest').id] }));
    assert.equal((await fetch(`${API}/api/leads/leads`, { headers: { cookie } })).status, 401, 'a changed role needs a fresh token');
  });

  await t.test('two refreshes at the same moment do not end the session', async () => {
    const jar = Object.fromEntries(vikram.cookie().split('; ').map((c) => [c.slice(0, c.indexOf('=')), c.slice(c.indexOf('=') + 1)]));
    const refresh = () => fetch(`${API}/api/auth/refresh`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: `nx_rt=${jar.nx_rt}` }, body: '{}' });
    const [a, b] = await Promise.all([refresh(), refresh()]);
    assert.deepEqual([a.status, b.status], [200, 200]);
    ok(await vikram.call('/leads/leads'));
  });
});

test('Email log: every email is recorded with what happened', async (t) => {
  const { client: owner, stamp } = await workspace(['tasks']);
  const member = await invite(owner, 'member', `${stamp}-m`);

  await t.test('a test email reports its outcome and lands in the log', async () => {
    const result = ok(await owner.call('/notifications/emails/test', 'POST', { to: `probe-${stamp}@nexus.test` }));
    assert.equal(result.status, 'logged');
    assert.match(result.error, /Test address/);
    const log = await owner.call('/notifications/emails');
    assert.equal(log.status, 200);
    const row = log.data.find((e) => e.to_address === `probe-${stamp}@nexus.test`);
    assert.equal(row.template, 'test');
    assert.ok(row.server, 'the server that handled it is recorded');
    assert.ok(log.meta.this_server.server);
  });

  await t.test('invitations are logged too, and only admins can read the log', async () => {
    await waitFor(async () => ok(await owner.call('/notifications/emails')).some((e) => e.template === 'invitation'));
    assert.ok(ok(await owner.call('/notifications/emails')).some((e) => e.template === 'invitation'));
    assert.equal((await member.call('/notifications/emails')).status, 403);
    assert.equal((await member.call('/notifications/emails/test', 'POST', {})).status, 403);
  });
});
