import { serverApi } from '@/lib/server-api';
import GeneralClient from './general-client';

export const metadata = { title: 'General' };

export default async function GeneralSettingsPage() {
  const { data } = await serverApi('/organizations/current');
  return <GeneralClient organization={data} />;
}
