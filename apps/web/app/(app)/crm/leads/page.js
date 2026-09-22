import { Suspense } from 'react';
import LeadsClient from './leads-client';

export const metadata = { title: 'Leads' };

export default function LeadsPage() {
  return (
    <Suspense>
      <LeadsClient />
    </Suspense>
  );
}
