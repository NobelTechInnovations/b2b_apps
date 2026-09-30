import { Suspense } from 'react';
import Client from './plans-client';

export const metadata = { title: 'Inspection plans' };

export default function Page() {
  return (
    <Suspense>
      <Client />
    </Suspense>
  );
}
