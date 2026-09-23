import { Suspense } from 'react';
import PayslipsClient from './payslips-client';

export const metadata = { title: 'Payslips' };

export default function PayslipsPage() {
  return (
    <Suspense fallback={null}>
      <PayslipsClient />
    </Suspense>
  );
}
