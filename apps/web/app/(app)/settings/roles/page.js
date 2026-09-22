import { serverApi } from '@/lib/server-api';
import RolesClient from './roles-client';

export const metadata = { title: 'Roles & permissions' };

export default async function RolesPage() {
  const [roles, permissions] = await Promise.all([
    serverApi('/roles'),
    serverApi('/permissions'),
  ]);

  return <RolesClient roles={roles.data ?? []} permissionGroups={permissions.data ?? []} />;
}
