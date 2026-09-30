import { Suspense } from 'react';
import Client from './work-centers-client';

export const metadata = { title: 'Work centers' };

export default function Page() {
  return (
    <Suspense>
      <Client />
    </Suspense>
  );
}
