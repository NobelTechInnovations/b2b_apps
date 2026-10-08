import { serverApi } from '@/lib/server-api';
import ProfileClient from '../../(app)/settings/profile/profile-client';

export const metadata = { title: 'Your profile' };

export default async function PortalProfilePage() {
  const { data } = await serverApi('/auth/me');
  return <ProfileClient user={data?.user} />;
}
