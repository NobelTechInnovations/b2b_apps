import { Suspense } from 'react';
import Client from './subscriptions-client';

export const metadata = { title: 'Subscriptions' };

export default function Page() {
  return (
    <Suspense>
      <Client />
    </Suspense>
  );
}
