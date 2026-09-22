import { Suspense } from 'react';
import DealsClient from './deals-client';

export const metadata = { title: 'Deals' };

export default function DealsPage() {
  return (
    <Suspense>
      <DealsClient />
    </Suspense>
  );
}
