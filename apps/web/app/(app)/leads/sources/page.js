import { Suspense } from 'react';
import SourcesClient from './sources-client';

export const metadata = { title: 'Lead sources' };

export default function Page() {
  return (
    <Suspense>
      <SourcesClient />
    </Suspense>
  );
}
