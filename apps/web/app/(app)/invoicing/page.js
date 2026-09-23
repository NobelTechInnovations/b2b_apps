import { serverApi } from '@/lib/server-api';
import OverviewClient from './overview-client';

export const metadata = { title: 'Overview' };

export default async function InvoicingOverviewPage() {
  const [invoices, ageing] = await Promise.all([
    serverApi('/invoicing/invoices', { query: { limit: 8 } }),
    serverApi('/invoicing/ageing'),
  ]);

  return (
    <OverviewClient
      summary={invoices.meta?.summary}
      recent={invoices.data ?? []}
      ageing={ageing.data}
      error={invoices.error}
    />
  );
}
