import { Suspense } from 'react';
import Client from './vendors-client';

export const metadata = { title: 'Vendors' };

export default function Page() {
  return (
    <Suspense>
      <Client />
    </Suspense>
  );
}
