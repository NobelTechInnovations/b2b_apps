import { Suspense } from 'react';
import Client from './bom-client';

export const metadata = { title: 'Bills of materials' };

export default function Page() {
  return (
    <Suspense>
      <Client />
    </Suspense>
  );
}
