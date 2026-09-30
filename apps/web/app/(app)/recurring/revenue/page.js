import { Suspense } from 'react';
import Client from './revenue-client';

export const metadata = { title: 'Revenue' };

export default function Page() {
  return (
    <Suspense>
      <Client />
    </Suspense>
  );
}
