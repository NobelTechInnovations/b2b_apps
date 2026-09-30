import { Suspense } from 'react';
import Client from './warehouses-client';

export const metadata = { title: 'Warehouses' };

export default function Page() {
  return (
    <Suspense>
      <Client />
    </Suspense>
  );
}
