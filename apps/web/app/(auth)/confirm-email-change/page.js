import { Suspense } from 'react';
import ConfirmEmailChange from './confirm-client';

export const metadata = { title: 'Confirm email change', referrer: 'no-referrer' };

export default function ConfirmEmailChangePage() {
  return <Suspense><ConfirmEmailChange /></Suspense>;
}
