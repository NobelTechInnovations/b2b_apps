import { Suspense } from 'react';
import Client from './accounts-client';

export const metadata = { title: 'Chart of accounts' };

export default function Page() {
  return (
    <Suspense>
      <Client />
    </Suspense>
  );
}
