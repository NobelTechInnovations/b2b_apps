import { serverApi } from '@/lib/server-api';
import MembersClient from './members-client';

export const metadata = { title: 'People' };

export default async function MembersPage() {
  const [members, invitations, roles] = await Promise.all([
    serverApi('/members', { query: { limit: 100 } }),
    serverApi('/invitations'),
    serverApi('/roles'),
  ]);

  return (
    <MembersClient
      initialMembers={members.data ?? []}
      initialInvitations={invitations.data ?? []}
      roles={roles.data ?? []}
      error={members.error}
    />
  );
}
