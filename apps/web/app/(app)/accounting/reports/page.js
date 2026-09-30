import { Suspense } from 'react';
import Client from './reports-client';

export const metadata = { title: 'Reports' };

export default function Page() {
  return (
    <Suspense>
      <Client />
    </Suspense>
  );
}
