import { serverApi } from '@/lib/server-api';
import SecurityClient from './security-client';

export const metadata = { title: 'Security & sessions' };

export default async function SecurityPage() {
  const { data } = await serverApi('/account/sessions');
  return <SecurityClient initialSessions={data ?? []} />;
}
