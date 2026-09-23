import InvoiceDocument from './document-client';

export const metadata = { title: 'Invoice' };

export default async function InvoicePrintPage({ params }) {
  const { invoiceId } = await params;
  return <InvoiceDocument invoiceId={invoiceId} />;
}
