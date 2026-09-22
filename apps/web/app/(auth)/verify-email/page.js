import { Suspense } from 'react';
import VerifyClient from './verify-client';

export const metadata = { title: 'Confirm your email' };

export default function VerifyEmailPage() {
  return (
    <Suspense>
      <VerifyClient />
    </Suspense>
  );
}
