import { Suspense } from 'react';
import Client from './depreciation-client';

export const metadata = { title: 'Depreciation' };

export default function Page() {
  return (
    <Suspense>
      <Client />
    </Suspense>
  );
}
