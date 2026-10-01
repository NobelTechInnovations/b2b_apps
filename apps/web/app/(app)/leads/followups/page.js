import { Suspense } from 'react';
import FollowupsClient from './followups-client';

export const metadata = { title: 'Follow-ups' };

export default function Page() {
  return (
    <Suspense>
      <FollowupsClient />
    </Suspense>
  );
}
