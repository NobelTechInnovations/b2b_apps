export const PERMISSION_ACTIONS = ['view', 'create', 'edit', 'delete', 'manage', 'approve', 'export'];

/**
 * Seeded on every new organization. Custom roles are created on top of these.
 * `owner` is special: it implicitly holds every permission of every entitled
 * app, and at least one owner must always exist.
 */
export const SYSTEM_ROLES = [
  {
    slug: 'owner',
    name: 'Owner',
    description: 'Full control of the workspace, billing and apps.',
    implicit_all: true,
    protected: true,
  },
  {
    slug: 'admin',
    name: 'Administrator',
    description: 'Manages people, roles and app settings. No billing access.',
    grants: ['*.*.view', '*.*.create', '*.*.edit', '*.*.delete', '*.*.manage', '*.*.approve', '*.*.export', 'tasks.tasks.assign', 'tasks.time.log'],
    denies: ['billing.*.*'],
    protected: true,
  },
  {
    slug: 'member',
    name: 'Member',
    description: 'Day-to-day access to the apps they are assigned.',
    grants: ['*.*.view', '*.*.create', '*.*.edit', 'tasks.time.log'],
    denies: ['billing.*.*', '*.*.delete', 'core.settings.manage', 'core.roles.manage', 'catalog.apps.manage'],
    protected: true,
  },
  {
    slug: 'guest',
    name: 'Guest',
    description: 'Read-only access to explicitly shared records.',
    grants: ['*.*.view'],
    denies: ['billing.*.*', 'core.*.*'],
    protected: true,
  },
  {
    /**
     * The employee portal role.
     *
     * Deliberately the narrowest role on the platform: it grants only `self`
     * permissions, which every service resolves from the signed-in user rather
     * than from an id in the request. An employee holding this role cannot
     * name somebody else's record to read it, because no endpoint they can
     * reach takes an employee id at all.
     *
     * It is NOT a variant of `guest`. Guest can read whatever it is shown;
     * this role can read exactly one person's data — their own.
     */
    slug: 'employee',
    name: 'Employee',
    description: 'Their own payslips, attendance, leave and documents, plus the task boards they are added to.',
    // Tasks are safe to grant here because boards carry their own membership:
    // an employee sees only boards they were added to and their own to-dos.
    grants: ['*.self.*', 'tasks.tasks.view', 'tasks.tasks.create', 'tasks.tasks.edit', 'tasks.projects.view', 'tasks.time.view', 'tasks.time.log'],
    denies: ['billing.*.*', 'core.*.*', 'catalog.*.*'],
    portal: true,
    protected: true,
  },
];

/** Roles whose members land in the employee portal rather than the workspace. */
export const PORTAL_ROLES = new Set(
  SYSTEM_ROLES.filter((role) => role.portal).map((role) => role.slug),
);
