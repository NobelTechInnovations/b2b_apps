import { notFound } from 'next/navigation';
import { serverApi } from '@/lib/server-api';
import InvoiceView from './invoice-view';

export const metadata = { title: 'Invoice' };

export default async function InvoicePage({ params }) {
  const { invoiceId } = await params;
  const [invoice, organization] = await Promise.all([
    serverApi(`/subscriptions/current/invoices/${invoiceId}`),
    serverApi('/organizations/current'),
  ]);
  if (!invoice.data) notFound();
  return <InvoiceView invoice={invoice.data} organization={organization.data} />;
}
