import { serverApi } from '@/lib/server-api';
import { MarketingHeader } from '@/components/marketing/header';
import { MarketingFooter } from '@/components/marketing/footer';

/**
 * The public site. Rendered for everyone, but it knows whether you are signed
 * in so the header can say "Go to workspace" instead of "Sign in".
 */
export default async function MarketingLayout({ children }) {
  const { data } = await serverApi('/me/workspace');
  const signedIn = Boolean(data?.user);

  return (
    <div className="flex min-h-screen flex-col bg-[var(--surface-page)]">
      <MarketingHeader signedIn={signedIn} needsOnboarding={data?.needs_onboarding} />
      <main className="flex-1">{children}</main>
      <MarketingFooter />
    </div>
  );
}
