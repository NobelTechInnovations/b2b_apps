import { serverApi } from '@/lib/server-api';
import DashboardClient from './dashboard-client';

export const metadata = { title: 'Dashboard' };

export default async function DashboardPage() {
  const [workspace, organization] = await Promise.all([
    serverApi('/me/workspace'),
    serverApi('/organizations/current'),
  ]);

  return <DashboardClient workspace={workspace.data} organization={organization.data} />;
}
