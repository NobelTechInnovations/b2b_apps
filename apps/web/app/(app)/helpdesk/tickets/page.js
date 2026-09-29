import { Suspense } from 'react';
import TicketsClient from './tickets-client';

export const metadata = { title: 'Tickets' };

export default function TicketsPage() {
  return (
    <Suspense>
      <TicketsClient />
    </Suspense>
  );
}
