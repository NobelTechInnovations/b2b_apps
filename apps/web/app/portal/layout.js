import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { serverApi } from '@/lib/server-api';
import { WorkspaceProvider } from '@/lib/workspace';
import { ToastProvider } from '@/components/ui/toast';
import { PortalShell } from './portal-shell';

/**
 * The employee portal has its own frame.
 *
 * Not the workspace shell with things hidden — a person whose whole
 * relationship with the product is "my payslips and my leave" should not be
 * looking at a chrome built for running a company. One screen, five tabs,
 * their name in the corner.
 */
export default async function PortalLayout({ children }) {
  const [workspace, me] = await Promise.all([
    serverApi('/me/workspace'),
    serverApi('/auth/me'),
  ]);

  if (workspace.status === 401 || me.status === 401) {
    const next = (await headers()).get('x-nexus-page') ?? '/dashboard';
    redirect(`/session-refresh?next=${encodeURIComponent(next)}`);
  }
  if (workspace.data?.needs_onboarding) redirect('/onboarding');

  return (
    <ToastProvider>
      <WorkspaceProvider initial={workspace.data}>
        <PortalShell user={workspace.data?.user} organizations={me.data?.organizations ?? []}>
          {children}
        </PortalShell>
      </WorkspaceProvider>
    </ToastProvider>
  );
}
