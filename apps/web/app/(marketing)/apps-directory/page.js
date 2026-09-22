import { APPS } from '@nexus/contracts';
import DirectoryClient from './directory-client';

export const metadata = {
  title: 'All apps',
  description:
    'Every app on the Nexus platform — CRM, HR, inventory, invoicing, accounting, helpdesk, commerce, legal, security and more.',
};

export default function AppsDirectoryPage() {
  return <DirectoryClient total={APPS.filter((a) => !a.core).length} />;
}
