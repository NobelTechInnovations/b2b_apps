import { Suspense } from 'react';
import ImportClient from './import-client';

export const metadata = { title: 'Import leads' };

export default function Page() {
  return (
    <Suspense>
      <ImportClient />
    </Suspense>
  );
}
