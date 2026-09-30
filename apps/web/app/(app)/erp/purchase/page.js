import { Suspense } from 'react';
import Client from './purchase-client';

export const metadata = { title: 'Purchase orders' };

export default function Page() {
  return (
    <Suspense>
      <Client />
    </Suspense>
  );
}
