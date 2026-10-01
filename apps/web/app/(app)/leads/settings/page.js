import { Suspense } from 'react';
import SettingsClient from './settings-client';

export const metadata = { title: 'Fields & stages' };

export default function Page() {
  return (
    <Suspense>
      <SettingsClient />
    </Suspense>
  );
}
