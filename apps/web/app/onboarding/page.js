import { redirect } from 'next/navigation';
import { serverApi } from '@/lib/server-api';
import OnboardingWizard from './wizard';

export const metadata = { title: 'Set up your workspace' };

export default async function OnboardingPage({ searchParams }) {
  const { company } = (await searchParams) ?? {};
  const [me, plans] = await Promise.all([
    serverApi('/auth/me'),
    serverApi('/plans'),
  ]);

  if (me.status === 401) redirect('/login');

  return (
    <OnboardingWizard
      user={me.data?.user}
      plans={plans.data ?? []}
      company={typeof company === 'string' ? company.slice(0, 120) : ''}
    />
  );
}
