import { Suspense } from 'react';
import Client from './promotions-client';

export const metadata = { title: 'Promotions' };

export default function Page() {
  return (
    <Suspense>
      <Client />
    </Suspense>
  );
}
