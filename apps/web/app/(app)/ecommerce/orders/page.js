import { Suspense } from 'react';
import Client from './orders-client';

export const metadata = { title: 'Online orders' };

export default function Page() {
  return (
    <Suspense>
      <Client />
    </Suspense>
  );
}
