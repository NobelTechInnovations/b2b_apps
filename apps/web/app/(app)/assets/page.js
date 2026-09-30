import { Suspense } from 'react';
import Client from './register-client';

export const metadata = { title: 'Asset register' };

export default function Page() {
  return (
    <Suspense>
      <Client />
    </Suspense>
  );
}
