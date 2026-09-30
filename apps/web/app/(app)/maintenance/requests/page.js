import { Suspense } from 'react';
import Client from './requests-client';

export const metadata = { title: 'Requests' };

export default function Page() {
  return (
    <Suspense>
      <Client />
    </Suspense>
  );
}
