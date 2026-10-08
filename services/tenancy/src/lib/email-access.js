import { forbidden } from '@nexus/service-kit';
import { resolveMemberPermissions } from './permissions.js';

/** An organization administrator must not take over a global, multi-org login. */
export async function assertEmailChangeAccess(db, { actorId, userId, orgId }) {
  const actor = await db.one(
    `SELECT m.id FROM members m JOIN organizations o ON o.id = m.org_id
     WHERE m.user_id = $1 AND m.org_id = $2 AND m.status = 'active' AND o.status = 'active'`,
    [actorId, orgId],
  );
  if (!actor) throw forbidden('You must be an active workspace administrator.');
  const access = await resolveMemberPermissions(db, { orgId, memberId: actor.id });
  if (!access.isOwner && (!access.roles.includes('admin') || !access.permissions.has('core.members.edit'))) {
    throw forbidden('Only workspace owners and administrators can change another person\'s email.');
  }
  const memberships = await db.rows(
    `SELECT id, org_id, status FROM members WHERE user_id = $1 AND status <> 'removed'`, [userId],
  );
  const target = memberships.find((m) => m.org_id === orgId && m.status === 'active');
  if (!target) throw forbidden('That person is not an active member of this workspace.');
  if (memberships.some((m) => m.org_id !== orgId)) {
    throw forbidden('This person belongs to other workspaces. They must change their own email in Profile.');
  }
  const targetAccess = await resolveMemberPermissions(db, { orgId, memberId: target.id });
  if (targetAccess.isOwner) throw forbidden('Workspace owners must change their own email in Profile.');
}
