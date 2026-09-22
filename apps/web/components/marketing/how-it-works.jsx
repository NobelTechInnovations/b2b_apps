import { cn } from '@/lib/cn';

const STEPS = [
  {
    n: '01',
    title: 'Create your workspace',
    body: 'Name it, tell us your industry and size. Takes under a minute, no card required.',
  },
  {
    n: '02',
    title: 'Pick your apps',
    body: 'We suggest a starting set for your industry. Change anything — we work out the dependencies for you.',
  },
  {
    n: '03',
    title: 'Invite your team',
    body: 'One login gets them into every app they are allowed to use. Roles decide the rest.',
  },
  {
    n: '04',
    title: 'Add more when you are ready',
    body: 'Switch an app on mid-month and it connects to your existing data instantly. Switch it off and stop paying.',
  },
];

export function HowItWorks() {
  return (
    <section className="mx-auto max-w-6xl px-5 py-20 lg:px-8 lg:py-24">
      <div className="grid gap-12 lg:grid-cols-[0.85fr_1.15fr]">
        <div className="lg:sticky lg:top-24 lg:self-start">
          <p className="text-sm font-semibold text-[var(--text-brand)]">How it works</p>
          <h2 className="mt-2 text-[32px] font-semibold leading-tight tracking-[-0.03em] lg:text-[40px]">
            Live in an afternoon, not a quarter.
          </h2>
          <p className="mt-4 text-md leading-relaxed text-[var(--text-secondary)]">
            No implementation partner. No six-week discovery. You will have a
            working workspace before your coffee goes cold.
          </p>
        </div>

        <ol className="relative space-y-1">
          <span className="absolute bottom-8 left-[19px] top-8 w-px bg-[var(--border-default)]" aria-hidden="true" />

          {STEPS.map((step, index) => (
            <li key={step.n} className="relative flex gap-5 py-4">
              <span
                className={cn(
                  'relative z-10 flex size-10 shrink-0 items-center justify-center rounded-full',
                  'bg-[var(--surface-raised)] text-sm font-semibold tabular',
                  index === 0
                    ? 'text-white shadow-[var(--glow-brand)] ring-0'
                    : 'text-[var(--text-tertiary)] ring-1 ring-[var(--border-default)]',
                )}
                style={index === 0 ? { background: 'linear-gradient(180deg,var(--color-brand-500),var(--color-brand-600))' } : undefined}
              >
                {step.n}
              </span>
              <div className="pt-1.5">
                <h3 className="text-md font-semibold">{step.title}</h3>
                <p className="mt-1.5 text-base leading-relaxed text-[var(--text-secondary)]">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
