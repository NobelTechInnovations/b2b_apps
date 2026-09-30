import { Suspense } from 'react';
import Client from './products-client';

export const metadata = { title: 'Products' };

export default function Page() {
  return (
    <Suspense>
      <Client />
    </Suspense>
  );
}
