import { Layers, KeyRound, Puzzle, IndianRupee } from 'lucide-react';

const PROPS = [
  {
    icon: Puzzle,
    title: 'Only what you need',
    body: 'Start with CRM. Add HR next quarter. Drop it if it stops earning its place. Your bill follows your choices, not a bundle someone else designed.',
    accent: 'var(--color-brand-600)',
  },
  {
    icon: Layers,
    title: 'One set of data',
    body: 'A customer is a customer everywhere. Sales, support, invoicing and accounting read the same record — no syncing, no duplicates, no drift.',
    accent: '#0ea5e9',
  },
  {
    icon: KeyRound,
    title: 'One sign-in',
    body: 'One login, one set of roles, one permission model across every app. Revoke someone once and they are out of all of it, immediately.',
    accent: '#10b981',
  },
  {
    icon: IndianRupee,
    title: 'Priced for India',
    body: 'GST-ready invoicing, PF and TDS in payroll, rupee-first pricing and financial years that start in April. Not an afterthought.',
    accent: '#f59e0b',
  },
];

export function ValueProps() {
  return (
    <section className="mx-auto max-w-6xl px-5 py-20 lg:px-8 lg:py-24">
      <div className="max-w-2xl">
        <p className="text-sm font-semibold text-[var(--text-brand)]">Why Nexus</p>
        <h2 className="mt-2 text-[32px] font-semibold leading-tight tracking-[-0.03em] lg:text-[40px]">
          Most business software makes you
          <br className="hidden sm:block" /> choose between the two.
        </h2>
        <p className="mt-4 text-md leading-relaxed text-[var(--text-secondary)]">
          Buy one big suite and pay for modules you will never open. Or stitch
          five tools together and spend your week reconciling them. Nexus is the
          third option.
        </p>
      </div>

      <div className="mt-12 grid gap-4 sm:grid-cols-2">
        {PROPS.map((prop) => (
          <div key={prop.title} className="panel panel-hover p-6">
            <span
              className="flex size-10 items-center justify-center rounded-[var(--radius-lg)]"
              style={{ background: `color-mix(in srgb, ${prop.accent} 12%, transparent)`, color: prop.accent }}
            >
              <prop.icon className="size-5" strokeWidth={1.75} />
            </span>
            <h3 className="mt-4 text-md font-semibold">{prop.title}</h3>
            <p className="mt-2 text-base leading-relaxed text-[var(--text-secondary)]">{prop.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
