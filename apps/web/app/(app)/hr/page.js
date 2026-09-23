import { serverApi } from '@/lib/server-api';
import OverviewClient from './overview-client';

export const metadata = { title: 'Overview' };

export default async function HrOverviewPage() {
  const { data, error } = await serverApi('/hr/overview');
  return <OverviewClient overview={data} error={error} />;
}
