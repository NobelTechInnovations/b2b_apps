import { Suspense } from 'react';
import Client from './journal-client';

export const metadata = { title: 'Journal' };

export default function Page() {
  return (
    <Suspense>
      <Client />
    </Suspense>
  );
}
