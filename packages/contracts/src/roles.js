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
    grants: ['*.*.view', '*.*.create', '*.*.edit', '*.*.delete', '*.*.manage', '*.*.approve', '*.*.export'],
    denies: ['billing.*.*'],
    protected: true,
  },
  {
    slug: 'member',
    name: 'Member',
    description: 'Day-to-day access to the apps they are assigned.',
    grants: ['*.*.view', '*.*.create', '*.*.edit'],
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
];
