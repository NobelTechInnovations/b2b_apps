import { Suspense } from 'react';
import ClaimsClient from '../claims-client';

export const metadata = { title: 'Approvals' };

export default function ApprovalsPage() {
  return (
    <Suspense>
      <ClaimsClient scope="team" />
    </Suspense>
  );
}
