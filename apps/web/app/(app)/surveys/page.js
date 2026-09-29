import { Suspense } from 'react';
import FormsClient from './forms-client';

export const metadata = { title: 'Forms' };

export default function FormsPage() {
  return (
    <Suspense>
      <FormsClient />
    </Suspense>
  );
}
