import { Suspense } from 'react';
import Client from './overview-client';

export const metadata = { title: 'Overview' };

export default function Page() {
  return (
    <Suspense>
      <Client />
    </Suspense>
  );
}
