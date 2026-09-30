import { Suspense } from 'react';
import Client from './checks-client';

export const metadata = { title: 'Checks' };

export default function Page() {
  return (
    <Suspense>
      <Client />
    </Suspense>
  );
}
