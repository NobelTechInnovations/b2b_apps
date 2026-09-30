import { Suspense } from 'react';
import Client from './stock-client';

export const metadata = { title: 'Stock' };

export default function Page() {
  return (
    <Suspense>
      <Client />
    </Suspense>
  );
}
