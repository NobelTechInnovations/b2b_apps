import { Suspense } from 'react';
import Client from './orders-client';

export const metadata = { title: 'Manufacturing orders' };

export default function Page() {
  return (
    <Suspense>
      <Client />
    </Suspense>
  );
}
