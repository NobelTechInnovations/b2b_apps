import { redirect } from 'next/navigation';
import { serverApi } from '@/lib/server-api';
import OnboardingWizard from './wizard';

export const metadata = { title: 'Set up your workspace' };

export default async function OnboardingPage() {
  const [me, plans] = await Promise.all([
    serverApi('/auth/me'),
    serverApi('/plans'),
  ]);

  if (me.status === 401) redirect('/login');

  return (
    <OnboardingWizard
      user={me.data?.user}
      plans={plans.data ?? []}
      appPrices={plans.meta?.app_prices ?? []}
    />
  );
}
