import Link from 'next/link';
import { Check, ArrowRight } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';

const PLANS = [
  {
    slug: 'starter',
    name: 'Starter',
    price: 'Free',
    cadence: 'up to 5 users',
    tagline: 'For small teams getting organised',
    features: ['5 users', '5 GB storage', 'Tasks included', 'Email support'],
  },
  {
    slug: 'growth',
    name: 'Growth',
    price: '₹1,499',
    cadence: 'per month',
    tagline: 'For businesses running on more than spreadsheets',
    features: [
      '25 users included',
      '100 GB storage',
      'Custom roles & permissions',
      'API access & audit log',
      'Priority support',
    ],
    featured: true,
  },
  {
    slug: 'scale',
    name: 'Scale',
    price: '₹4,999',
    cadence: 'per month',
    tagline: 'For companies running the whole business here',
    features: [
      '100 users included',
      '1 TB storage',
      'SSO & SAML',
      'Dedicated success manager',
      '99.9% uptime SLA',
    ],
  },
];

export function PricingTeaser() {
  return (
    <section className="border-y border-[var(--border-subtle)] bg-[var(--surface-raised)]">
      <div className="mx-auto max-w-6xl px-5 py-20 lg:px-8 lg:py-24">
        <div className="text-center">
          <p className="text-sm font-semibold text-[var(--text-brand)]">Pricing</p>
          <h2 className="mx-auto mt-2 max-w-2xl text-[32px] font-semibold leading-tight tracking-[-0.03em] lg:text-[40px]">
            A platform fee, plus the apps you choose.
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-md text-[var(--text-secondary)]">
            The plan buys your workspace, users, storage and support. Apps are
            added on top from ₹199 per user per month — and removed just as easily.
          </p>
        </div>

        <div className="mt-12 grid gap-5 lg:grid-cols-3">
          {PLANS.map((plan) => (
            <div
              key={plan.slug}
              className={cn(
                'panel relative flex flex-col p-6',
                plan.featured && 'shadow-[var(--glow-brand)] ring-1 ring-[var(--color-brand-400)]',
              )}
            >
              {plan.featured && (
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-[var(--color-brand-600)] px-3 py-1 text-2xs font-semibold text-white shadow-sm">
                  Most popular
                </span>
              )}

              <h3 className="text-md font-semibold">{plan.name}</h3>
              <p className="mt-1 text-sm text-[var(--text-secondary)]">{plan.tagline}</p>

              <p className="mt-5 flex items-baseline gap-1.5">
                <span className="text-[34px] font-semibold tabular leading-none tracking-[-0.03em]">
                  {plan.price}
                </span>
                <span className="text-sm text-[var(--text-tertiary)]">{plan.cadence}</span>
              </p>

              <ul className="mt-6 flex-1 space-y-2.5">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-2 text-base text-[var(--text-secondary)]">
                    <Check className="mt-0.5 size-4 shrink-0 text-[var(--color-positive-500)]" strokeWidth={2.5} />
                    {feature}
                  </li>
                ))}
              </ul>

              <Link href="/signup" className="mt-7">
                <Button
                  size="lg"
                  variant={plan.featured ? 'primary' : 'secondary'}
                  className={cn('w-full', plan.featured && 'cta')}
                >
                  Start free trial
                </Button>
              </Link>
            </div>
          ))}
        </div>

        <p className="mt-8 text-center text-sm text-[var(--text-secondary)]">
          Every plan starts with a 14-day trial of everything you select.{' '}
          <Link href="/pricing" className="font-medium text-[var(--text-brand)] hover:underline">
            See the full price list
          </Link>
        </p>
      </div>
    </section>
  );
}
