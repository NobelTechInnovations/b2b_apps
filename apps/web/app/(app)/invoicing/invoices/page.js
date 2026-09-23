import { Suspense } from 'react';
import InvoicesClient from './invoices-client';

export const metadata = { title: 'Invoices' };

export default function InvoicesPage() {
  return (
    <Suspense>
      <InvoicesClient />
    </Suspense>
  );
}
