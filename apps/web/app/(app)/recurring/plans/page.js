import { Suspense } from 'react';
import Client from './plans-client';

export const metadata = { title: 'Plans' };

export default function Page() {
  return (
    <Suspense>
      <Client />
    </Suspense>
  );
}
