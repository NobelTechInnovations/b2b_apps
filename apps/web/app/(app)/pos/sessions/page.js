import { Suspense } from 'react';
import Client from './sessions-client';

export const metadata = { title: 'Sessions' };

export default function Page() {
  return (
    <Suspense>
      <Client />
    </Suspense>
  );
}
