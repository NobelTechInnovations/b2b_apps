import { Suspense } from 'react';
import JoinClient from './join-client';

export const metadata = { title: 'Join a workspace' };

export default function JoinPage() {
  return (
    <Suspense>
      <JoinClient />
    </Suspense>
  );
}
