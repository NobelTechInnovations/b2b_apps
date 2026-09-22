import { serverApi } from '@/lib/server-api';
import ProfileClient from './profile-client';

export const metadata = { title: 'Your profile' };

export default async function ProfilePage() {
  const { data } = await serverApi('/auth/me');
  return <ProfileClient user={data?.user} />;
}
