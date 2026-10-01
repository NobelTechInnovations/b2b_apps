import { peopleDirectory } from '@nexus/service-kit';
import { insertEmployee } from './employees.js';
import { ensureLeaveTypes } from './setup.js';

/**
 * The workspace's people (logins) and HR's employees (staff records) are two
 * lists that should not drift apart. This finds people who have a login but
 * no employee record, and adds them — linking an existing record with their
 * email instead of creating a second one.
 *
 * Guests (accountants, partners, clients given read-only access) are never
 * made employees.
 */
export function createWorkspacePeople({ tenancyUrl, serviceToken, logger }) {
  const directory = peopleDirectory({ tenancyUrl, serviceToken });

  async function members(orgId) {
    const response = await fetch(`${tenancyUrl}/internal/orgs/${orgId}/members`, {
      headers: { 'x-nexus-service-token': serviceToken },
      signal: AbortSignal.timeout(8_000),
    }).catch(() => null);
    if (!response?.ok) throw new Error(`could not list the workspace's people (${response?.status ?? 'unreachable'})`);
    return (await response.json()).data ?? [];
  }

  /** People with a login and no employee record (owners and admins included). */
  async function unlinked(db, orgId) {
    const people = (await members(orgId)).filter((p) => !(p.roles.length === 1 && p.roles[0] === 'guest'));
    if (!people.length) return [];
    const [names, linked] = await Promise.all([
      directory.lookup(people.map((p) => p.user_id)),
      db.rows(`SELECT user_id FROM employees WHERE org_id = $1 AND archived_at IS NULL AND user_id IS NOT NULL`, [orgId]),
    ]);
    const taken = new Set(linked.map((r) => r.user_id));
    return people
      .filter((p) => !taken.has(p.user_id))
      .map((p) => ({ user_id: p.user_id, name: names.get(p.user_id)?.name ?? null, email: names.get(p.user_id)?.email ?? null, title: p.title, roles: p.roles, joined_at: p.joined_at }));
  }

  /**
   * Make these people employees. Returns how many records were created and
   * how many existing ones (same email, no login yet) were linked instead.
   */
  async function add(db, { orgId, actorId = null, userIds }) {
    const wanted = new Set(userIds);
    const people = (await unlinked(db, orgId)).filter((p) => wanted.has(p.user_id));
    if (!people.length) return { created: 0, linked: 0, employees: [] };
    await ensureLeaveTypes(db, orgId);
    const result = { created: 0, linked: 0, employees: [] };
    for (const person of people) {
      const employee = await db.transaction(async (tx) => {
        const email = person.email?.toLowerCase() ?? null;
        const existing = email ? await tx.one(
          `SELECT id FROM employees WHERE org_id = $1 AND archived_at IS NULL AND user_id IS NULL
              AND (lower(email) = $2 OR lower(personal_email) = $2) ORDER BY created_at LIMIT 1 FOR UPDATE`,
          [orgId, email],
        ) : null;
        let employeeId = existing?.id;
        if (!employeeId) {
          const [first, ...rest] = (person.name?.trim() || email?.split('@')[0] || 'Team member').split(/\s+/);
          const created = await insertEmployee(tx, {
            orgId, userId: actorId,
            fields: { first_name: first.slice(0, 80), last_name: rest.join(' ').slice(0, 80) || null, email, designation: person.title ?? null },
          });
          employeeId = created.id;
          result.created += 1;
        } else {
          result.linked += 1;
        }
        return tx.one(
          `UPDATE employees SET user_id = $3, portal_status = 'active', portal_linked_at = now(), updated_at = now()
            WHERE org_id = $1 AND id = $2 RETURNING id, employee_code, first_name, last_name`,
          [orgId, employeeId, person.user_id],
        );
      });
      result.employees.push(employee);
    }
    logger?.info({ orgId, ...result, employees: undefined }, 'workspace people added as employees');
    return result;
  }

  return { members, unlinked, add };
}

/**
 * Does this workspace use HR? Someone has opened it (leave types exist) or
 * added an employee. A workspace that bought HR and never opened it gets the
 * "add your people" prompt on the Employees screen instead.
 */
export async function usesHr(db, orgId) {
  const row = await db.one(
    `SELECT EXISTS (SELECT 1 FROM leave_types WHERE org_id = $1) OR EXISTS (SELECT 1 FROM employees WHERE org_id = $1) AS yes`,
    [orgId],
  );
  return Boolean(row?.yes);
}
