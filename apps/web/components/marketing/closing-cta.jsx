import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function ClosingCta() {
  return (
    <section className="mx-auto max-w-6xl px-5 py-20 lg:px-8 lg:py-24">
      <div className="aurora panel sheen relative overflow-hidden px-8 py-16 text-center lg:px-16">
        <div className="fine-grid pointer-events-none absolute inset-0" />

        <div className="relative">
          <h2 className="mx-auto max-w-2xl text-[32px] font-semibold leading-tight tracking-[-0.03em] lg:text-[42px]">
            Build your workspace in the next ten minutes.
          </h2>
          <p className="mx-auto mt-4 max-w-lg text-md text-[var(--text-secondary)]">
            Pick your apps, invite your team, and see your own data in it today.
            Nothing to install, nothing to migrate to get started.
          </p>

          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link href="/signup">
              <Button size="xl" className="cta w-full sm:w-auto">
                Start free
                <ArrowRight className="size-4" strokeWidth={2} />
              </Button>
            </Link>
            <Link href="/contact">
              <Button size="xl" variant="secondary" className="w-full sm:w-auto">
                Talk to sales
              </Button>
            </Link>
          </div>

          <p className="mt-5 text-xs text-[var(--text-tertiary)]">
            No credit card · 14-day trial · Your data stays yours
          </p>
        </div>
      </div>
    </section>
  );
}
