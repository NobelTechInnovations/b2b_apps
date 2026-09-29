import { Suspense } from 'react';
import JobsClient from './jobs-client';

export const metadata = { title: 'Openings' };

export default function JobsPage() {
  return (
    <Suspense>
      <JobsClient />
    </Suspense>
  );
}
