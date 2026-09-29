import Link from 'next/link';
import { Logo } from '@/components/brand';

/**
 * Pages anyone can open without an account: a company's careers page and
 * its published forms. They sit outside the workspace shell, so no session,
 * sidebar or company-address redirect applies.
 */
export default function PublicLayout({ children }) {
  return (
    <div className="flex min-h-screen flex-col bg-[var(--surface-page)]">
      <main className="flex-1 px-4 py-10 sm:py-14">{children}</main>
      <footer className="pb-8 text-center text-xs text-[var(--text-tertiary)]">
        <Link href="/" className="inline-flex items-center gap-1.5 hover:text-[var(--text-secondary)]">
          <Logo size={14} /> Powered by Nexus
        </Link>
      </footer>
    </div>
  );
}
