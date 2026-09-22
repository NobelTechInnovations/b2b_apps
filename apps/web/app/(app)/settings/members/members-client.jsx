'use client';

import { useState } from 'react';
import { UserPlus, MoreHorizontal, Search, Mail, Copy, Trash2, ShieldCheck, Clock } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { relativeTime } from '@/lib/format';
import { useWorkspace, Can } from '@/lib/workspace';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Field, Select, Textarea } from '@/components/ui/input';
import { Modal, ConfirmModal } from '@/components/ui/modal';
import { Menu, MenuItem, MenuDivider } from '@/components/ui/menu';
import { Table, THead, TBody, TH, TR, TD } from '@/components/ui/table';
import { Avatar, Badge, PageHeader, EmptyState, Card, Alert } from '@/components/ui/primitives';

export default function MembersClient({ initialMembers, initialInvitations, roles, error }) {
  const toast = useToast();
  const { workspace } = useWorkspace();

  const [members, setMembers] = useState(initialMembers);
  const [invitations, setInvitations] = useState(initialInvitations);
  const [query, setQuery] = useState('');
  const [inviting, setInviting] = useState(false);
  const [removing, setRemoving] = useState(null);
  const [busy, setBusy] = useState(false);

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
                          <MenuItem icon={ShieldCheck}>Change roles</MenuItem>
                          <MenuItem icon={Mail}>Send a message</MenuItem>
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
                    {invitation.roles.map((r) => r.name).join(', ')}
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

      <InviteModal
        open={inviting}
        roles={roles}
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

function InviteModal({ open, roles, onClose, onInvited }) {
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [roleId, setRoleId] = useState('');
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [link, setLink] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const memberRole = roles.find((r) => r.slug === 'member');

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const response = await api.post('/invitations', {
        email,
        role_ids: [roleId || memberRole?.id].filter(Boolean),
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
