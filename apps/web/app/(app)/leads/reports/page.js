import { Suspense } from 'react';
import ReportsClient from './reports-client';

export const metadata = { title: 'Reports' };

export default function Page() {
  return (
    <Suspense>
      <ReportsClient />
    </Suspense>
  );
}
