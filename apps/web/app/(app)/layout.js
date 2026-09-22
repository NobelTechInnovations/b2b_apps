import { redirect } from 'next/navigation';
import { serverApi } from '@/lib/server-api';
import { AppShell } from '@/components/shell/app-shell';

/**
 * One server-side call boots the shell. If the session is gone we redirect
 * before rendering anything; if there is no workspace yet, onboarding owns
 * the user until there is.
 */
export default async function AppLayout({ children }) {
  const [workspace, me] = await Promise.all([
    serverApi('/me/workspace'),
    serverApi('/auth/me'),
  ]);

  if (workspace.status === 401 || me.status === 401) redirect('/login');

  if (workspace.error && workspace.status === 503) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="max-w-sm text-center">
          <h1 className="text-lg font-semibold">We can&apos;t reach the platform</h1>
          <p className="mt-2 text-base text-[var(--text-secondary)]">
            The API gateway is not responding. If you are running this locally,
            check that the services are up.
          </p>
          <code className="mt-4 block rounded-[var(--radius-md)] bg-[var(--surface-sunken)] px-3 py-2 text-xs">
            pnpm infra:up &amp;&amp; pnpm dev
          </code>
        </div>
      </div>
    );
  }

  if (workspace.data?.needs_onboarding) redirect('/onboarding');

  return (
    <AppShell workspace={workspace.data} organizations={me.data?.organizations ?? []}>
      {children}
    </AppShell>
  );
}
