import { serverApi } from '@/lib/server-api';
import BillingClient from './billing-client';

export const metadata = { title: 'Plan & billing' };

export default async function BillingPage() {
  const [subscription, plans, organization] = await Promise.all([
    serverApi('/subscriptions/current'),
    serverApi('/plans'),
    serverApi('/organizations/current'),
  ]);

  return (
    <BillingClient
      subscription={subscription.data}
      plans={plans.data ?? []}
      usage={organization.data?.counts ?? null}
    />
  );
}
