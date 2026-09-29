import { Suspense } from 'react';
import ClaimsClient from './claims-client';

export const metadata = { title: 'My claims' };

export default function MyClaimsPage() {
  return (
    <Suspense>
      <ClaimsClient scope="mine" />
    </Suspense>
  );
}
