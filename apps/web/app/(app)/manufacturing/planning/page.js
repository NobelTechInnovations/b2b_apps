import { Suspense } from 'react';
import Client from './planning-client';

export const metadata = { title: 'Planning' };

export default function Page() {
  return (
    <Suspense>
      <Client />
    </Suspense>
  );
}
