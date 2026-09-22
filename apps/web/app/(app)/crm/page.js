import { serverApi } from '@/lib/server-api';
import OverviewClient from './overview-client';

export const metadata = { title: 'Overview' };

export default async function CrmOverviewPage() {
  const { data, error } = await serverApi('/crm/overview');
  return <OverviewClient overview={data} error={error} />;
}
