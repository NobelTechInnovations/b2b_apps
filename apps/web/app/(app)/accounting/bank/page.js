import { Suspense } from 'react';
import Client from './bank-client';

export const metadata = { title: 'Bank' };

export default function Page() {
  return (
    <Suspense>
      <Client />
    </Suspense>
  );
}
