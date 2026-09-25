'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowRight, ArrowLeft, Check, Building2, Users, Sparkles, Loader2, PartyPopper,
} from 'lucide-react';
import { APPS, APP_CATEGORIES, resolveDependencies } from '@nexus/contracts';
import { cn } from '@/lib/cn';
import { api, ApiError } from '@/lib/api';
import { money } from '@/lib/format';
import { Wordmark } from '@/components/brand';
import { Button } from '@/components/ui/button';
import { Input, Field, Select } from '@/components/ui/input';
import { Badge, Alert, Card } from '@/components/ui/primitives';
import { Icon, tintFor } from '@/components/shell/icon';

const INDUSTRIES = [
  'Software & IT', 'Manufacturing', 'Retail & E-commerce', 'Professional services',
  'Healthcare', 'Education', 'Construction', 'Logistics', 'Hospitality',
  'Finance & Insurance', 'Media & Marketing', 'Other',
];

const SIZES = [
  { value: '1-10', label: '1–10', hint: 'Just getting started' },
  { value: '11-50', label: '11–50', hint: 'Growing team' },
  { value: '51-200', label: '51–200', hint: 'Established' },
  { value: '201-500', label: '201–500', hint: 'Large' },
  { value: '500+', label: '500+', hint: 'Enterprise' },
];

/** Sensible starting points, so nobody faces fifteen checkboxes cold. */
const PRESETS = {
  'Software & IT': ['crm', 'tasks', 'invoicing'],
  Manufacturing: ['erp', 'invoicing', 'hr'],
  'Retail & E-commerce': ['erp', 'crm', 'invoicing'],
  'Professional services': ['crm', 'tasks', 'invoicing', 'hr'],
  Healthcare: ['hr', 'tasks', 'documents'],
  Education: ['hr', 'tasks', 'documents'],
  Construction: ['tasks', 'erp', 'invoicing'],
  Logistics: ['erp', 'tasks', 'invoicing'],
  Hospitality: ['hr', 'erp', 'invoicing'],
  'Finance & Insurance': ['crm', 'accounting', 'documents'],
  'Media & Marketing': ['crm', 'tasks', 'invoicing'],
  Other: ['crm', 'tasks'],
};

const STEPS = ['Workspace', 'Your business', 'Choose apps', 'Pick a plan'];

export default function OnboardingWizard({ user, plans, appPrices }) {
  const router = useRouter();

  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [quote, setQuote] = useState(null);

  const [form, setForm] = useState({
    name: '',
    industry: '',
    size_band: '11-50',
    apps: [],
    plan: 'growth',
    cycle: 'monthly',
    seats: 10,
  });

  const priceBySlug = useMemo(
    () => new Map(appPrices.map((p) => [p.app_slug, p])),
    [appPrices],
  );

  // Dependencies are resolved as you pick, so the total never surprises anyone.
  const resolved = useMemo(() => {
    try {
      return resolveDependencies(form.apps);
    } catch {
      return form.apps;
    }
  }, [form.apps]);

  const autoAdded = resolved.filter((slug) => !form.apps.includes(slug));

  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  const toggleApp = (slug) =>
    setForm((f) => ({
      ...f,
      apps: f.apps.includes(slug) ? f.apps.filter((s) => s !== slug) : [...f.apps, slug],
    }));

  function chooseIndustry(industry) {
    setForm((f) => ({
      ...f,
      industry,
      apps: f.apps.length ? f.apps : (PRESETS[industry] ?? []).filter(slug => APPS.some(app => app.slug === slug && app.status === 'available')),
    }));
  }

  async function refreshQuote(next = form) {
    try {
      const response = await api.post('/subscriptions/quote', {
        plan: next.plan,
        app_slugs: next.apps,
        seats: next.seats,
        cycle: next.cycle,
      });
      setQuote(response.data);
    } catch {
      setQuote(null);
    }
  }

  async function goNext() {
    setError(null);

    if (step === 0 && form.name.trim().length < 2) {
      setError('Give your workspace a name of at least two characters.');
      return;
    }
    if (step === 1 && !form.industry) {
      setError('Pick the closest industry so we can suggest the right apps.');
      return;
    }
    if (step === 2) await refreshQuote();

    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  }

  async function finish() {
    setBusy(true);
    setError(null);

    try {
      // 1 — the workspace itself
      await api.post('/organizations', {
        name: form.name.trim(),
        industry: form.industry,
        size_band: form.size_band,
      });

      // 2 — a token that carries the new organization
      await api.post('/auth/refresh', {});

      // 3 — the subscription, which is what actually grants the apps
      await api.post('/subscriptions', {
        plan: form.plan,
        app_slugs: form.apps,
        seats: form.seats,
        cycle: form.cycle,
      });

      setStep(STEPS.length);
      setTimeout(() => {
        router.push('/dashboard');
        router.refresh();
      }, 1_400);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'We could not finish setting up. Please try again.',
      );
      setBusy(false);
    }
  }

  if (step === STEPS.length) return <Done name={form.name} />;

  return (
    <div className="min-h-screen bg-[var(--surface-page)]">
      <header className="flex h-14 items-center justify-between border-b border-[var(--border-subtle)] bg-[var(--surface-raised)] px-6">
        <Wordmark />
        <span className="text-sm text-[var(--text-tertiary)]">{user?.email}</span>
      </header>

      <div className="mx-auto max-w-3xl px-6 py-10">
        <Stepper step={step} />

        <div className="mt-8 animate-rise" key={step}>
          {step === 0 && <StepWorkspace form={form} set={set} />}
          {step === 1 && <StepBusiness form={form} set={set} onIndustry={chooseIndustry} />}
          {step === 2 && (
            <StepApps
              form={form}
              toggleApp={toggleApp}
              autoAdded={autoAdded}
              priceBySlug={priceBySlug}
            />
          )}
          {step === 3 && (
            <StepPlan
              form={form}
              set={set}
              plans={plans}
              quote={quote}
              resolved={resolved}
              onChange={(next) => refreshQuote({ ...form, ...next })}
            />
          )}
        </div>

        {error && <Alert tone="critical" className="mt-6">{error}</Alert>}

        <div className="mt-8 flex items-center justify-between">
          <Button
            variant="ghost"
            icon={ArrowLeft}
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            disabled={step === 0 || busy}
          >
            Back
          </Button>

          {step < STEPS.length - 1 ? (
            <Button variant="primary" size="lg" iconRight={ArrowRight} onClick={goNext}>
              Continue
            </Button>
          ) : (
            <Button variant="primary" size="lg" loading={busy} onClick={finish} iconRight={ArrowRight}>
              Create my workspace
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── steps ────────────────────────────────────────────────────────────────── */

function Stepper({ step }) {
  return (
    <ol className="flex items-center gap-2">
      {STEPS.map((label, index) => (
        <li key={label} className="flex flex-1 items-center gap-2">
          <span
            className={cn(
              'flex size-6 shrink-0 items-center justify-center rounded-full text-2xs font-semibold transition-colors',
              index < step
                ? 'bg-[var(--color-brand-600)] text-white'
                : index === step
                  ? 'bg-[var(--color-brand-600)] text-white ring-4 ring-[var(--color-brand-100)] dark:ring-[rgb(99_102_241/0.2)]'
                  : 'bg-[var(--surface-active)] text-[var(--text-tertiary)]',
            )}
          >
            {index < step ? <Check className="size-3.5" strokeWidth={3} /> : index + 1}
          </span>
          <span
            className={cn(
              'hidden text-sm font-medium sm:block',
              index <= step ? 'text-[var(--text-primary)]' : 'text-[var(--text-tertiary)]',
            )}
          >
            {label}
          </span>
          {index < STEPS.length - 1 && (
            <span className={cn('h-px flex-1', index < step ? 'bg-[var(--color-brand-500)]' : 'bg-[var(--border-default)]')} />
          )}
        </li>
      ))}
    </ol>
  );
}

function StepWorkspace({ form, set }) {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-[-0.025em]">Name your workspace</h1>
      <p className="mt-1.5 text-md text-[var(--text-secondary)]">
        Usually your company name. Everyone you invite will see this.
      </p>

      <div className="mt-7 max-w-md">
        <Field label="Workspace name" hint="You can change this later in settings.">
          {(props) => (
            <Input
              {...props}
              size="lg"
              icon={Building2}
              placeholder="Acme Industries"
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              autoFocus
            />
          )}
        </Field>
      </div>
    </div>
  );
}

function StepBusiness({ form, set, onIndustry }) {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-[-0.025em]">Tell us about your business</h1>
      <p className="mt-1.5 text-md text-[var(--text-secondary)]">
        We will suggest a starting set of apps. You can change everything on the next step.
      </p>

      <div className="mt-7 space-y-6">
        <div className="max-w-md">
          <Field label="Industry">
            {(props) => (
              <Select {...props} value={form.industry} onChange={(e) => onIndustry(e.target.value)}>
                <option value="">Choose an industry…</option>
                {INDUSTRIES.map((industry) => (
                  <option key={industry} value={industry}>{industry}</option>
                ))}
              </Select>
            )}
          </Field>
        </div>

        <div>
          <p className="mb-2.5 text-sm font-medium">How many people work there?</p>
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-5">
            {SIZES.map((size) => (
              <button
                key={size.value}
                onClick={() => {
                  set('size_band', size.value);
                  set('seats', { '1-10': 5, '11-50': 25, '51-200': 60, '201-500': 150, '500+': 300 }[size.value]);
                }}
                className={cn(
                  'rounded-[var(--radius-lg)] border p-3 text-left transition-all duration-150',
                  form.size_band === size.value
                    ? 'border-[var(--color-brand-500)] bg-[var(--color-brand-50)] shadow-[var(--ring-focus)] dark:bg-[rgb(99_102_241/0.1)]'
                    : 'border-[var(--border-default)] bg-[var(--surface-raised)] hover:border-[var(--border-strong)]',
                )}
              >
                <span className="flex items-center gap-1.5 text-base font-semibold tabular">
                  <Users className="size-3.5 text-[var(--text-tertiary)]" />
                  {size.label}
                </span>
                <span className="mt-0.5 block text-2xs text-[var(--text-tertiary)]">{size.hint}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function StepApps({ form, toggleApp, autoAdded, priceBySlug }) {
  const available = APPS.filter((a) => !a.core && a.status !== 'coming_soon');

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-[-0.025em]">What do you want to manage?</h1>
      <p className="mt-1.5 text-md text-[var(--text-secondary)]">
        Pick as many as you like. Every app shares the same people, customers and documents —
        and you can add or drop any of them later.
      </p>

      {autoAdded.length > 0 && (
        <Alert tone="info" className="mt-5" icon={Sparkles}>
          We will also include{' '}
          <strong>{autoAdded.map((s) => APPS.find((a) => a.slug === s)?.name).join(', ')}</strong>,
          because your selection depends on {autoAdded.length === 1 ? 'it' : 'them'}.
        </Alert>
      )}

      <div className="mt-6 space-y-7">
        {APP_CATEGORIES.map((category) => {
          const apps = available.filter((a) => a.category === category.slug);
          if (!apps.length) return null;

          return (
            <section key={category.slug}>
              <h2 className="mb-2.5 text-sm font-semibold text-[var(--text-secondary)]">
                {category.name}
              </h2>
              <div className="grid gap-2.5 sm:grid-cols-2">
                {apps.map((app) => {
                  const selected = form.apps.includes(app.slug);
                  const auto = autoAdded.includes(app.slug);
                  const price = priceBySlug.get(app.slug);

                  return (
                    <button
                      key={app.slug}
                      onClick={() => toggleApp(app.slug)}
                      className={cn(
                        'group flex items-start gap-3 rounded-[var(--radius-lg)] border p-3.5 text-left',
                        'transition-all duration-150',
                        selected
                          ? 'border-[var(--color-brand-500)] bg-[var(--color-brand-50)] dark:bg-[rgb(99_102_241/0.08)]'
                          : auto
                            ? 'border-dashed border-[var(--color-brand-300)] bg-[var(--surface-raised)]'
                            : 'border-[var(--border-default)] bg-[var(--surface-raised)] hover:border-[var(--border-strong)]',
                      )}
                    >
                      <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-md)]', tintFor(app.color))}>
                        <Icon name={app.icon} className="size-4" />
                      </span>

                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate text-base font-medium">{app.name}</span>
                          {auto && <Badge size="sm" tone="brand">Required</Badge>}
                        </span>
                        <span className="mt-0.5 block line-clamp-1 text-xs text-[var(--text-secondary)]">
                          {app.tagline}
                        </span>
                        <span className="mt-1.5 block text-2xs text-[var(--text-tertiary)] tabular">
                          {price
                            ? `${money(price.price_monthly, price.currency)} / ${price.billing_unit} / month`
                            : `${money(app.price.monthly, app.price.currency)} / ${app.price.per} / month`}
                        </span>
                      </span>

                      <span
                        className={cn(
                          'mt-0.5 flex size-4.5 shrink-0 items-center justify-center rounded-[var(--radius-xs)] border transition-colors',
                          selected
                            ? 'border-[var(--color-brand-600)] bg-[var(--color-brand-600)] text-white'
                            : 'border-[var(--border-strong)]',
                        )}
                        style={{ width: 18, height: 18 }}
                      >
                        {selected && <Check className="size-3" strokeWidth={3} />}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function StepPlan({ form, set, plans, quote, resolved, onChange }) {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-[-0.025em]">Pick a plan</h1>
      <p className="mt-1.5 text-md text-[var(--text-secondary)]">
        Every plan starts with a 14-day free trial. No card needed today.
      </p>

      <div className="mt-6 inline-flex rounded-[var(--radius-lg)] bg-[var(--surface-sunken)] p-0.5">
        {['monthly', 'annual'].map((cycle) => (
          <button
            key={cycle}
            onClick={() => {
              set('cycle', cycle);
              onChange({ cycle });
            }}
            className={cn(
              'rounded-[var(--radius-md)] px-3.5 py-1.5 text-sm font-medium capitalize transition-colors',
              form.cycle === cycle
                ? 'bg-[var(--surface-raised)] text-[var(--text-primary)] shadow-xs'
                : 'text-[var(--text-secondary)]',
            )}
          >
            {cycle}
            {cycle === 'annual' && (
              <span className="ml-1.5 text-2xs font-semibold text-[var(--color-positive-600)]">
                2 months free
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="mt-5 grid gap-3 md:grid-cols-3">
        {plans.map((plan) => {
          const selected = form.plan === plan.slug;
          const price = form.cycle === 'annual' ? plan.base_price_annual : plan.base_price_monthly;

          return (
            <button
              key={plan.slug}
              onClick={() => {
                set('plan', plan.slug);
                onChange({ plan: plan.slug });
              }}
              className={cn(
                'relative rounded-[var(--radius-xl)] border p-4 text-left transition-all duration-150',
                selected
                  ? 'border-[var(--color-brand-500)] bg-[var(--color-brand-50)] dark:bg-[rgb(99_102_241/0.08)]'
                  : 'border-[var(--border-default)] bg-[var(--surface-raised)] hover:border-[var(--border-strong)]',
              )}
            >
              {plan.slug === 'growth' && (
                <Badge tone="brand" size="sm" className="absolute right-3 top-3">Popular</Badge>
              )}
              <p className="text-md font-semibold">{plan.name}</p>
              <p className="mt-0.5 text-xs text-[var(--text-secondary)]">{plan.tagline}</p>

              <p className="mt-3 text-xl font-semibold tabular tracking-[-0.02em]">
                {Number(price) === 0 ? 'Free' : money(price, plan.currency)}
                {Number(price) > 0 && (
                  <span className="text-xs font-normal text-[var(--text-tertiary)]">
                    {' '}/ {form.cycle === 'annual' ? 'year' : 'month'}
                  </span>
                )}
              </p>

              <ul className="mt-3 space-y-1.5">
                {(plan.features ?? []).slice(0, 4).map((feature) => (
                  <li key={feature} className="flex items-start gap-1.5 text-xs text-[var(--text-secondary)]">
                    <Check className="mt-0.5 size-3 shrink-0 text-[var(--color-positive-500)]" strokeWidth={3} />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>
            </button>
          );
        })}
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-[1fr_320px]">
        <Card className="p-4">
          <Field label="How many people need access?" hint="You can add or remove seats at any time.">
            {(props) => (
              <Input
                {...props}
                type="number"
                min={1}
                value={form.seats}
                onChange={(e) => {
                  const seats = Math.max(1, Number(e.target.value) || 1);
                  set('seats', seats);
                  onChange({ seats });
                }}
                className="max-w-[140px]"
              />
            )}
          </Field>
        </Card>

        <Card className="overflow-hidden">
          <div className="border-b border-[var(--border-subtle)] px-4 py-3">
            <p className="text-sm font-semibold">Your subscription</p>
          </div>

          <div className="space-y-2 px-4 py-3">
            {quote ? (
              <>
                {quote.lines.map((line) => (
                  <div key={line.slug} className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="min-w-0 truncate text-[var(--text-secondary)]">{line.label}</span>
                    <span className="shrink-0 tabular">
                      {line.amount === 0 ? 'Included' : money(line.amount, 'INR')}
                    </span>
                  </div>
                ))}

                <div className="!mt-3 space-y-1.5 border-t border-[var(--border-subtle)] pt-3">
                  <div className="flex justify-between text-sm text-[var(--text-secondary)]">
                    <span>Subtotal</span>
                    <span className="tabular">{money(quote.subtotal, 'INR')}</span>
                  </div>
                  <div className="flex justify-between text-sm text-[var(--text-secondary)]">
                    <span>GST (18%)</span>
                    <span className="tabular">{money(quote.tax_amount, 'INR')}</span>
                  </div>
                  <div className="flex items-baseline justify-between pt-1 text-md font-semibold">
                    <span>Total</span>
                    <span className="tabular">
                      {money(quote.total, 'INR')}
                      <span className="text-xs font-normal text-[var(--text-tertiary)]">
                        /{form.cycle === 'annual' ? 'yr' : 'mo'}
                      </span>
                    </span>
                  </div>
                </div>
              </>
            ) : (
              <div className="flex items-center gap-2 py-6 text-sm text-[var(--text-tertiary)]">
                <Loader2 className="size-3.5 animate-spin" /> Working out your price…
              </div>
            )}
          </div>

          <div className="border-t border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-4 py-3">
            <p className="flex items-start gap-1.5 text-xs text-[var(--text-secondary)]">
              <Sparkles className="mt-px size-3.5 shrink-0 text-[var(--color-brand-500)]" />
              Free for 14 days. Nothing is charged until your trial ends, and you
              can cancel from settings at any point.
            </p>
          </div>
        </Card>
      </div>

      <p className="mt-4 text-xs text-[var(--text-tertiary)]">
        Includes {resolved.length} app{resolved.length === 1 ? '' : 's'}:{' '}
        {resolved.map((slug) => APPS.find((a) => a.slug === slug)?.name).join(', ')}
      </p>
    </div>
  );
}

function Done({ name }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
      <div className="animate-pop flex size-14 items-center justify-center rounded-[var(--radius-2xl)] bg-[var(--color-positive-500)] text-white">
        <PartyPopper className="size-7" strokeWidth={1.75} />
      </div>
      <h1 className="mt-6 text-2xl font-semibold tracking-[-0.025em]">{name} is ready</h1>
      <p className="mt-2 max-w-sm text-md text-[var(--text-secondary)]">
        Setting up your apps and taking you to your dashboard…
      </p>
      <Loader2 className="mt-6 size-5 animate-spin text-[var(--text-tertiary)]" />
    </div>
  );
}
