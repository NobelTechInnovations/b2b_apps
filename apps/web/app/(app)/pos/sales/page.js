import { Suspense } from 'react';
import Client from './sales-client';

export const metadata = { title: 'Sales' };

export default function Page() {
  return (
    <Suspense>
      <Client />
    </Suspense>
  );
}
