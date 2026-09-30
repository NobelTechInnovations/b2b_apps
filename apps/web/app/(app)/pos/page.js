import { Suspense } from 'react';
import Client from './registers-client';

export const metadata = { title: 'Registers' };

export default function Page() {
  return (
    <Suspense>
      <Client />
    </Suspense>
  );
}
