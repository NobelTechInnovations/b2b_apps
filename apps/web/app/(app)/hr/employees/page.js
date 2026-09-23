import { Suspense } from 'react';
import EmployeesClient from './employees-client';

export const metadata = { title: 'Employees' };

export default function EmployeesPage() {
  return (
    <Suspense>
      <EmployeesClient />
    </Suspense>
  );
}
