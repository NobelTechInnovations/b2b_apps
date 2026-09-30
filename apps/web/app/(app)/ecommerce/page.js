import { Suspense } from 'react';
import Client from './store-client';

export const metadata = { title: 'Storefront' };

export default function Page() {
  return (
    <Suspense>
      <Client />
    </Suspense>
  );
}
