'use client';

import { useState } from 'react';
import { UserPlus, MoreHorizontal, Search, Mail, Copy, Trash2, ShieldCheck, Clock, LayoutGrid } from 'lucide-react';
import { appBySlug } from '@nexus/contracts';
import { api, ApiError } from '@/lib/api';
import { relativeTime } from '@/lib/format';
import { useWorkspace, Can } from '@/lib/workspace';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Field, Select, Textarea, Checkbox } from '@/components/ui/input';
import { Modal, ConfirmModal } from '@/components/ui/modal';
import { Menu, MenuItem, MenuDivider } from '@/components/ui/menu';
import { Table, THead, TBody, TH, TR, TD } from '@/components/ui/table';
import { Avatar, Badge, PageHeader, EmptyState, Card, Alert } from '@/components/ui/primitives';
import { Icon } from '@/components/shell/icon';
import { tintFor } from '@/lib/app-theme';

/** Owners and admins are never limited to some apps. */
const unlimited = (roles) => roles.some((r) => r.slug === 'owner' || r.slug === 'admin');

export default function MembersClient({ initialMembers, initialInvitations, roles, error }) {
  const toast = useToast();
  const { workspace } = useWorkspace();

  const [members, setMembers] = useState(initialMembers);
  const [invitations, setInvitations] = useState(initialInvitations);
  const [query, setQuery] = useState('');
  const [inviting, setInviting] = useState(false);
  const [removing, setRemoving] = useState(null);
  const [busy, setBusy] = useState(false);
  const [appsFor, setAppsFor] = useState(null);
  const [rolesFor, setRolesFor] = useState(null);

  // The apps this workspace has switched on — the ones there is anything to share.
  const workspaceApps = (workspace?.workspace_apps ?? [])
    .filter((slug) => (workspace?.installed ?? []).includes(slug))
    .map(appBySlug)
    .filter((app) => app && !app.core);
  const replace = (member) => setMembers((current) => current.map((m) => (m.id === member.id ? { ...m, ...member } : m)));

  const filtered = members.filter((m) => {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return [m.name, m.email, m.title].some((v) => v?.toLowerCase().includes(needle));
  });

  async function removeMember(member) {
    setBusy(true);
    try {
      await api.del(`/members/${member.id}`);
      setMembers((current) => current.filter((m) => m.id !== member.id));
      toast.success(`${member.name ?? member.email} was removed`, {
        description: 'Their sessions for this workspace have ended.',
      });
    } catch (err) {
      toast.error('Could not remove them', {
        description: err instanceof ApiError ? err.message : 'Please try again.',
      });
    } finally {
      setBusy(false);
      setRemoving(null);
    }
  }

  async function revokeInvitation(invitation) {
    try {
      await api.del(`/invitations/${invitation.id}`);
      setInvitations((current) => current.filter((i) => i.id !== invitation.id));
      toast.success('Invitation revoked');
    } catch {
      toast.error('Could not revoke that invitation');
    }
  }

  if (error) {
    return <Alert tone="critical">We could not load your team right now. {error.message}</Alert>;
  }

  return (
    <div>
      <PageHeader
        title="People"
        description="Everyone with access to this workspace, and what they are allowed to do."
        actions={
          <Can permission="core.members.invite">
            <Button variant="primary" icon={UserPlus} onClick={() => setInviting(true)}>
              Invite people
            </Button>
          </Can>
        }
      />

      <div className="mb-4 flex items-center gap-3">
        <Input
          icon={Search}
          placeholder="Search by name, email or title…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="max-w-xs"
        />
        <span className="text-sm text-[var(--text-tertiary)] tabular">
          {members.length} {members.length === 1 ? 'person' : 'people'}
          {invitations.length > 0 && ` · ${invitations.length} invited`}
        </span>
      </div>

      {filtered.length === 0 ? (
        <Card>
          <EmptyState
            icon={Search}
            title={query ? 'Nobody matches that' : 'No people yet'}
            description={query ? 'Try a different search.' : 'Invite your first teammate to get started.'}
          />
        </Card>
      ) : (
        <Table>
          <THead>
            <tr>
              <TH>Person</TH>
              <TH>Roles</TH>
              <TH>Apps</TH>
              <TH>Status</TH>
              <TH>Joined</TH>
              <TH width={48} />
            </tr>
          </THead>
          <TBody>
            {filtered.map((member) => {
              const isYou = member.id === workspace?.member?.id;
              return (
                <TR key={member.id}>
                  <TD>
                    <div className="flex items-center gap-2.5">
                      <Avatar name={member.name ?? member.email} src={member.avatar_url} size="md" />
                      <div className="min-w-0">
                        <p className="flex items-center gap-1.5 truncate font-medium">
                          {member.name ?? member.email}
                          {isYou && <span className="text-2xs text-[var(--text-tertiary)]">(you)</span>}
                        </p>
                        <p className="truncate text-xs text-[var(--text-tertiary)]">
                          {member.title ? `${member.title} · ${member.email}` : member.email}
                        </p>
                      </div>
                    </div>
                  </TD>
                  <TD>
                    <div className="flex flex-wrap gap-1">
                      {member.roles.map((role) => (
                        <Badge key={role.id} size="sm" tone={role.slug === 'owner' ? 'brand' : 'neutral'}>
                          {role.name}
                        </Badge>
                      ))}
                    </div>
                  </TD>
                  <TD>
                    <AppsSummary member={member} />
                  </TD>
                  <TD>
                    <Badge
                      size="sm"
                      dot
                      tone={member.status === 'active' ? 'positive' : member.status === 'suspended' ? 'critical' : 'caution'}
                    >
                      {member.status}
                    </Badge>
                  </TD>
                  <TD className="text-[var(--text-secondary)]">{relativeTime(member.joined_at)}</TD>
                  <TD>
                    {!isYou && (
                      <Can permission="core.members.edit">
                        <Menu
                          align="end"
                          width={200}
                          trigger={
                            <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${member.name}`}>
                              <MoreHorizontal className="size-4" />
                            </Button>
                          }
                        >
                          <Can permission="core.roles.manage">
                            <MenuItem icon={LayoutGrid} onClick={() => setAppsFor(member)}>App access</MenuItem>
                            <MenuItem icon={ShieldCheck} onClick={() => setRolesFor(member)}>Change role</MenuItem>
                          </Can>
                          <MenuDivider />
                          <MenuItem icon={Trash2} danger onClick={() => setRemoving(member)}>
                            Remove from workspace
                          </MenuItem>
                        </Menu>
                      </Can>
                    )}
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      )}

      {invitations.length > 0 && (
        <div className="mt-8">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-medium text-[var(--text-secondary)]">
            <Clock className="size-3.5" /> Pending invitations
          </h2>
          <Card className="divide-y divide-[var(--border-subtle)]">
            {invitations.map((invitation) => (
              <div key={invitation.id} className="flex items-center gap-3 px-4 py-3">
                <Avatar name={invitation.email} size="md" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-base font-medium">{invitation.email}</p>
                  <p className="truncate text-xs text-[var(--text-tertiary)]">
                    Invited {relativeTime(invitation.created_at)} ·{' '}
                    {invitation.roles.map((r) => r.name).join(', ')} ·{' '}
                    {unlimited(invitation.roles) || !invitation.app_access ? 'every app' : invitation.app_access.map((slug) => appBySlug(slug)?.name ?? slug).join(', ')}
                  </p>
                </div>
                <Can permission="core.members.invite">
                  <Button variant="ghost" size="sm" onClick={() => revokeInvitation(invitation)}>
                    Revoke
                  </Button>
                </Can>
              </div>
            ))}
          </Card>
        </div>
      )}

      <AppAccessModal
        member={appsFor}
        apps={workspaceApps}
        onClose={() => setAppsFor(null)}
        onSaved={(member) => { replace(member); setAppsFor(null); }}
      />

      <RolesModal
        member={rolesFor}
        roles={roles}
        onClose={() => setRolesFor(null)}
        onSaved={(member) => { replace(member); setRolesFor(null); }}
      />

      <InviteModal
        open={inviting}
        roles={roles}
        apps={workspaceApps}
        onClose={() => setInviting(false)}
        onInvited={(invitation) => setInvitations((current) => [invitation, ...current])}
      />

      <ConfirmModal
        open={Boolean(removing)}
        onClose={() => setRemoving(null)}
        onConfirm={() => removeMember(removing)}
        loading={busy}
        danger
        confirmLabel="Remove"
        title={`Remove ${removing?.name ?? removing?.email}?`}
        description="They lose access to this workspace immediately and every active session ends. Records they created stay."
      />
    </div>
  );
}

function InviteModal({ open, roles, apps, onClose, onInvited }) {
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [roleId, setRoleId] = useState('');
  // New people start with Boards; give them more here or later.
  const [access, setAccess] = useState(['tasks']);
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [link, setLink] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const memberRole = roles.find((r) => r.slug === 'member');
  const chosenRole = roles.find((r) => r.id === (roleId || memberRole?.id));
  const roleIsAdmin = chosenRole && unlimited([chosenRole]);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const response = await api.post('/invitations', {
        email,
        role_ids: [roleId || memberRole?.id].filter(Boolean),
        app_access: roleIsAdmin ? null : access.filter((slug) => apps.some((a) => a.slug === slug)),
        title: title || undefined,
        message: message || undefined,
      });

      onInvited(response.data);
      setLink(response.data.invite_link);
      toast.success(`Invitation sent to ${email}`);
      setEmail('');
      setTitle('');
      setMessage('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send that invitation.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        setLink(null);
        setError(null);
        onClose();
      }}
      title="Invite people"
      description="They will get an email with a link to join this workspace."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Done</Button>
          <Button variant="primary" onClick={submit} loading={busy} icon={UserPlus}>
            Send invitation
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert tone="critical">{error}</Alert>}

        {link && (
          <Alert
            tone="positive"
            action={
              <Button
                variant="ghost"
                size="xs"
                icon={Copy}
                onClick={() => {
                  navigator.clipboard.writeText(link);
                  toast.success('Invite link copied');
                }}
              >
                Copy
              </Button>
            }
          >
            Invitation sent. You can also share the link directly.
          </Alert>
        )}

        <Field label="Email address" required>
          {(props) => (
            <Input
              {...props}
              type="email"
              icon={Mail}
              placeholder="colleague@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              data-autofocus
            />
          )}
        </Field>

        <Field label="Role" hint="Roles decide what they can see and change. You can adjust this later.">
          {(props) => (
            <Select {...props} value={roleId} onChange={(e) => setRoleId(e.target.value)}>
              {roles
                .filter((r) => r.slug !== 'owner')
                .map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name} — {role.description}
                  </option>
                ))}
            </Select>
          )}
        </Field>

        <Field label="Apps they can open" hint={roleIsAdmin ? 'Administrators always see every app.' : 'Only these appear for them. You can change this any time from their row.'}>
          {() => (roleIsAdmin ? (
            <p className="text-sm text-[var(--text-secondary)]">Every app</p>
          ) : (
            <AppChecklist apps={apps} value={access} onChange={setAccess} />
          ))}
        </Field>

        <Field label="Job title" hint="Optional.">
          {(props) => (
            <Input {...props} placeholder="Sales Manager" value={title} onChange={(e) => setTitle(e.target.value)} />
          )}
        </Field>

        <Field label="Personal note" hint="Optional. Included in the invitation email.">
          {(props) => (
            <Textarea
              {...props}
              rows={3}
              placeholder="Hi! Joining us on Nexus so we can run sales in one place."
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
          )}
        </Field>
      </form>
    </Modal>
  );
}

/* ── which apps each person may open ──────────────────────────────────────── */
function AppsSummary({ member }) {
  if (unlimited(member.roles) || !member.app_access) {
    return <span className="text-sm text-[var(--text-secondary)]">Every app</span>;
  }
  if (!member.app_access.length) return <span className="text-sm text-[var(--text-tertiary)]">None</span>;
  const shown = member.app_access.slice(0, 3);
  return (
    <div className="flex flex-wrap items-center gap-1">
      {shown.map((slug) => <Badge key={slug} size="sm">{appBySlug(slug)?.name ?? slug}</Badge>)}
      {member.app_access.length > shown.length && <span className="text-xs text-[var(--text-tertiary)]">+{member.app_access.length - shown.length}</span>}
    </div>
  );
}

function AppChecklist({ apps, value, onChange }) {
  return (
    <div className="grid max-h-64 gap-1 overflow-y-auto rounded-[var(--radius-lg)] border border-[var(--border-subtle)] p-2 sm:grid-cols-2">
      {apps.map((app) => (
        <label key={app.slug} className="flex cursor-pointer items-center gap-2.5 rounded-[var(--radius-md)] px-2 py-1.5 hover:bg-[var(--surface-hover)]">
          <input
            type="checkbox"
            className="size-4"
            checked={value.includes(app.slug)}
            onChange={(e) => onChange(e.target.checked ? [...value, app.slug] : value.filter((slug) => slug !== app.slug))}
          />
          <span className={`flex size-6 items-center justify-center rounded-[var(--radius-sm)] ${tintFor(app.color)}`}>
            <Icon name={app.icon} className="size-3.5" />
          </span>
          <span className="text-sm">{app.name}</span>
        </label>
      ))}
      {apps.length === 0 && <p className="p-2 text-sm text-[var(--text-tertiary)]">This workspace has no apps switched on yet.</p>}
    </div>
  );
}

function AppAccessModal({ member, apps, onClose, onSaved }) {
  const toast = useToast();
  const [everything, setEverything] = useState(false);
  const [access, setAccess] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [shownFor, setShownFor] = useState(null);

  if (member && shownFor !== member.id) {
    setShownFor(member.id);
    setEverything(!member.app_access);
    setAccess(member.app_access ?? apps.map((a) => a.slug));
    setError(null);
  }
  if (!member) return null;
  const admin = unlimited(member.roles);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const response = await api.put(`/members/${member.id}/apps`, { app_access: everything ? null : access });
      toast.success('App access saved', { description: 'It applies to their next click — no need to sign in again.' });
      setShownFor(null);
      onSaved(response.data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={() => { setShownFor(null); onClose(); }}
      title={`Apps for ${member.name ?? member.email}`}
      description="The workspace switches apps on; this decides which of them this person sees."
      footer={
        <>
          <Button variant="ghost" onClick={() => { setShownFor(null); onClose(); }}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={admin} onClick={save}>Save</Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert tone="critical">{error}</Alert>}
        {admin ? (
          <Alert tone="info">Owners and administrators always see every app. Change their role to limit them.</Alert>
        ) : (
          <>
            <Checkbox checked={everything} onChange={(e) => setEverything(e.target.checked)} label="Every app" description="Including apps the workspace adds later." />
            {!everything && <AppChecklist apps={apps} value={access} onChange={setAccess} />}
            <p className="text-xs text-[var(--text-tertiary)]">Their own payslips, leave and attendance stay available whatever you choose here. Inside each app, their role still decides what they can change.</p>
          </>
        )}
      </div>
    </Modal>
  );
}

function RolesModal({ member, roles, onClose, onSaved }) {
  const toast = useToast();
  const { workspace } = useWorkspace();
  const [roleId, setRoleId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [shownFor, setShownFor] = useState(null);

  if (member && shownFor !== member.id) {
    setShownFor(member.id);
    setRoleId(member.roles[0]?.id ?? '');
    setError(null);
  }
  if (!member) return null;
  const choices = roles.filter((r) => r.slug !== 'owner' || workspace?.member?.is_owner);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const response = await api.put(`/members/${member.id}/roles`, { role_ids: [roleId] });
      toast.success('Role changed');
      setShownFor(null);
      onSaved({ ...member, roles: response.data.roles });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change the role.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={() => { setShownFor(null); onClose(); }}
      title={`Role for ${member.name ?? member.email}`}
      description="The role decides what they can do inside the apps they can open."
      footer={
        <>
          <Button variant="ghost" onClick={() => { setShownFor(null); onClose(); }}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!roleId} onClick={save}>Save</Button>
        </>
      }
    >
      <div className="space-y-2">
        {error && <Alert tone="critical">{error}</Alert>}
        {choices.map((role) => (
          <label key={role.id} className="flex cursor-pointer items-start gap-2.5 rounded-[var(--radius-lg)] border border-[var(--border-subtle)] px-3 py-2.5 hover:bg-[var(--surface-hover)]">
            <input type="radio" name="role" className="mt-1" checked={roleId === role.id} onChange={() => setRoleId(role.id)} />
            <span>
              <span className="block font-medium">{role.name}</span>
              <span className="block text-xs text-[var(--text-tertiary)]">{role.description}</span>
            </span>
          </label>
        ))}
      </div>
    </Modal>
  );
}
