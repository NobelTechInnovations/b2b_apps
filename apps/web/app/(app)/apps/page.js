import { serverApi } from '@/lib/server-api';
import MarketplaceClient from './marketplace-client';

export const metadata = { title: 'Apps' };

export default async function AppsPage() {
  const { data, meta } = await serverApi('/apps');
  return <MarketplaceClient initialApps={data ?? []} meta={meta ?? {}} />;
}
