import Link from 'next/link';
import { Wordmark } from '@/components/brand';

const PROOF = [
  { metric: '15', label: 'business apps, one workspace' },
  { metric: '1', label: 'sign-in across everything' },
  { metric: '0', label: 'apps you pay for and never use' },
];

export default function AuthLayout({ children }) {
  return (
    <div className="flex min-h-screen">
      {/* ── the form ─────────────────────────────────────────────────────── */}
      <div className="flex w-full flex-col px-6 py-8 lg:w-[52%] lg:px-16">
        <header className="flex items-center justify-between">
          <Link href="/" className="rounded-[var(--radius-md)]">
            <Wordmark />
          </Link>
        </header>

        <main className="flex flex-1 items-center justify-center py-10">
          <div className="w-full max-w-[380px] animate-rise">{children}</div>
        </main>

        <footer className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-[var(--text-tertiary)]">
          <span>© {new Date().getFullYear()} Nexus</span>
          <Link href="/privacy" className="hover:text-[var(--text-secondary)]">Privacy</Link>
          <Link href="/terms" className="hover:text-[var(--text-secondary)]">Terms</Link>
        </footer>
      </div>

      {/* ── the panel ────────────────────────────────────────────────────── */}
      <aside className="relative hidden overflow-hidden bg-[var(--color-ink-950)] lg:block lg:w-[48%]">
        <div
          className="absolute inset-0 opacity-[0.07]"
          style={{
            backgroundImage:
              'linear-gradient(to right, white 1px, transparent 1px), linear-gradient(to bottom, white 1px, transparent 1px)',
            backgroundSize: '44px 44px',
          }}
        />
        <div className="absolute -left-24 -top-24 size-[420px] rounded-full bg-[var(--color-brand-600)] opacity-25 blur-[120px]" />
        <div className="absolute -bottom-32 right-0 size-[380px] rounded-full bg-[#0ea5e9] opacity-20 blur-[120px]" />

        <div className="relative flex h-full flex-col justify-between p-14">
          <div />

          <div className="max-w-md">
            <h2 className="text-[32px] font-semibold leading-[1.15] tracking-[-0.03em] text-white">
              Build the workspace your
              <br />
              business actually runs on.
            </h2>
            <p className="mt-5 text-md leading-relaxed text-[var(--color-ink-400)]">
              CRM, HR, projects, inventory, invoicing, accounting, helpdesk — pick
              what you need today, switch the rest on when you are ready. Same
              people, same customers, same login.
            </p>
          </div>

          <dl className="grid grid-cols-3 gap-6 border-t border-white/10 pt-8">
            {PROOF.map((item) => (
              <div key={item.label}>
                <dt className="text-2xl font-semibold tabular text-white">{item.metric}</dt>
                <dd className="mt-1 text-xs leading-snug text-[var(--color-ink-500)]">{item.label}</dd>
              </div>
            ))}
          </dl>
        </div>
      </aside>
    </div>
  );
}
