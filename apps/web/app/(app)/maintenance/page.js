import { Suspense } from 'react';
import Client from './equipment-client';

export const metadata = { title: 'Equipment' };

export default function Page() {
  return (
    <Suspense>
      <Client />
    </Suspense>
  );
}
