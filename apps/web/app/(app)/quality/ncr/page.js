import { Suspense } from 'react';
import Client from './ncr-client';

export const metadata = { title: 'Non-conformance' };

export default function Page() {
  return (
    <Suspense>
      <Client />
    </Suspense>
  );
}
