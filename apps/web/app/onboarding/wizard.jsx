'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowRight, ArrowLeft, Check, Building2, Users, Sparkles, Loader2, PartyPopper,
} from 'lucide-react';
import { APPS, APP_CATEGORIES, resolveDependencies, pairedApps, relatedApps } from '@nexus/contracts';
import { cn } from '@/lib/cn';
import { api, ApiError } from '@/lib/api';
import { money } from '@/lib/format';
import { Wordmark } from '@/components/brand';
import { Button } from '@/components/ui/button';
import { Input, Field, Select } from '@/components/ui/input';
import { Badge, Alert, Card } from '@/components/ui/primitives';
import { Icon, tintFor } from '@/components/shell/icon';
import { subdomainsEnabled, tenantUrl } from '@/lib/tenant';

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

const appName = (slug) => APPS.find((a) => a.slug === slug)?.name ?? slug;

/** A preset plus whatever each of its apps pairs with. */
const withPairs = (slugs) => [...new Set(slugs.flatMap((slug) => [slug, ...pairedApps(slug)]))];

export default function OnboardingWizard({ user, plans, company = '' }) {
  const router = useRouter();

  // Arriving from sign-up with a company name skips straight to the business.
  const [step, setStep] = useState(company ? 1 : 0);
  const [paired, setPaired] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [quote, setQuote] = useState(null);
  const [address, setAddress] = useState(null);

  const [form, setForm] = useState({
    name: company,
    industry: '',
    size_band: '1-10',
    apps: [],
    // Apps the customer deliberately unticked are never re-added for them.
    removed: [],
    plan: plans[0]?.slug ?? 'basic',
    cycle: 'monthly',
    seats: plans[0]?.included_users ?? 10,
  });

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

  function toggleApp(slug) {
    if (form.apps.includes(slug)) {
      setForm((f) => ({ ...f, apps: f.apps.filter((s) => s !== slug), removed: [...f.removed, slug] }));
      setPaired(null);
      return;
    }
    // Picking HR pre-selects Payroll, CRM pre-selects Invoicing… — unless the
    // customer has already said no to it. Either stays one click from undone.
    const partners = pairedApps(slug).filter((p) => !form.apps.includes(p) && !form.removed.includes(p));
    setForm((f) => ({
      ...f,
      apps: [...f.apps, slug, ...partners],
      removed: f.removed.filter((s) => s !== slug),
    }));
    setPaired(partners.length ? { slug, partners } : null);
  }

  function chooseIndustry(industry) {
    setForm((f) => ({
      ...f,
      industry,
      apps: f.apps.length
        ? f.apps
        : withPairs((PRESETS[industry] ?? []).filter((slug) => APPS.some((app) => app.slug === slug && app.status === 'available'))),
    }));
  }

  // The cheaper plan for this many seats, so nobody overpays by accident.
  const cheapest = useMemo(() => {
    const cost = (plan) =>
      Number(plan.base_price_monthly) +
      Math.max(0, form.seats - plan.included_users) * Number(plan.extra_user_price);
    return [...plans].sort((a, b) => cost(a) - cost(b))[0]?.slug;
  }, [plans, form.seats]);

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
      // 1 — the workspace itself, at its own <company>-<digits> address
      const created = await api.post('/organizations', {
        name: form.name.trim(),
        industry: form.industry,
        size_band: form.size_band,
      });
      const slug = created.data.organization.slug;

      // 2 — a token that carries the new organization
      await api.post('/auth/refresh', {});

      // 3 — the subscription, which is what actually grants the apps
      const subscription = await api.post('/subscriptions', {
        plan: form.plan,
        app_slugs: form.apps,
        seats: form.seats,
        cycle: form.cycle,
      });

      // No trial means the first term is paid before anything unlocks.
      const landing = subscription.data.payment_required_now ? '/settings/billing' : '/dashboard';
      setStep(STEPS.length);
      setAddress(subdomainsEnabled() ? tenantUrl(slug, '/') : null);
      setTimeout(() => {
        if (subdomainsEnabled()) {
          window.location.href = tenantUrl(slug, landing);
          return;
        }
        router.push(landing);
        router.refresh();
      }, 1_600);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'We could not finish setting up. Please try again.',
      );
      setBusy(false);
    }
  }

  if (step === STEPS.length) return <Done name={form.name} address={address} />;

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
              paired={paired}
              resolved={resolved}
              plan={plans.find((p) => p.slug === form.plan) ?? plans[0]}
            />
          )}
          {step === 3 && (
            <StepPlan
              form={form}
              set={set}
              plans={plans}
              quote={quote}
              resolved={resolved}
              cheapest={cheapest}
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
                  set('seats', { '1-10': 10, '11-50': 25, '51-200': 60, '201-500': 150, '500+': 300 }[size.value]);
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

function StepApps({ form, toggleApp, autoAdded, paired, resolved, plan }) {
  const available = APPS.filter((a) => !a.core && a.status !== 'coming_soon');
  const included = plan?.included_app_count ?? 5;
  const extra = Math.max(0, resolved.length - included);
  const hints = [...new Set(form.apps.flatMap((slug) => relatedApps(slug)))].filter((slug) => !resolved.includes(slug));

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-[-0.025em]">What do you want to manage?</h1>
      <p className="mt-1.5 text-md text-[var(--text-secondary)]">
        Every plan includes any {included} apps. Apps that belong together are picked for you —
        untick anything you don&apos;t need.
      </p>

      <div className="sticky top-0 z-10 mt-5 flex flex-wrap items-center gap-3 rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-4 py-3 shadow-xs">
        <span className="text-sm font-semibold tabular">{resolved.length} selected</span>
        <span className="h-1.5 w-40 overflow-hidden rounded-full bg-[var(--surface-active)]">
          <span
            className={cn('block h-full rounded-full', extra ? 'bg-[var(--color-caution-500)]' : 'bg-[var(--color-brand-500)]')}
            style={{ width: `${Math.min(100, (resolved.length / included) * 100)}%` }}
          />
        </span>
        <span className="text-xs text-[var(--text-secondary)]">
          {extra
            ? `${included} included · ${extra} extra at ${money(plan?.extra_app_price ?? 99, 'INR')}/month each`
            : `${included - resolved.length} more included at no extra cost`}
        </span>
      </div>

      {paired && (
        <Alert tone="info" className="mt-4" icon={Sparkles}>
          Added <strong>{paired.partners.map(appName).join(', ')}</strong> because it works hand in hand with{' '}
          {appName(paired.slug)}. Untick it if you don&apos;t need it.
        </Alert>
      )}

      {autoAdded.length > 0 && (
        <Alert tone="info" className="mt-4" icon={Sparkles}>
          We will also include{' '}
          <strong>{autoAdded.map(appName).join(', ')}</strong>,
          because your selection depends on {autoAdded.length === 1 ? 'it' : 'them'}.
        </Alert>
      )}

      {hints.length > 0 && (
        <p className="mt-4 text-sm text-[var(--text-secondary)]">
          Works well with your picks:{' '}
          {hints.map((slug, index) => (
            <span key={slug}>
              <button className="font-medium text-[var(--text-brand)] hover:underline" onClick={() => toggleApp(slug)}>
                + {appName(slug)}
              </button>
              {index < hints.length - 1 ? ' · ' : ''}
            </span>
          ))}
        </p>
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
                  const partners = pairedApps(app.slug);

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
                        {partners.length > 0 && (
                          <span className="mt-1.5 block text-2xs text-[var(--text-tertiary)]">
                            Pairs with {partners.map(appName).join(', ')}
                          </span>
                        )}
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

function StepPlan({ form, set, plans, quote, resolved, cheapest, onChange }) {
  const trialDays = Number(plans.find((p) => p.slug === form.plan)?.trial_days ?? 0);
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-[-0.025em]">Pick a plan</h1>
      <p className="mt-1.5 text-md text-[var(--text-secondary)]">
        {trialDays > 0
          ? `Every plan starts with a ${trialDays}-day free trial. Each term is then paid in advance.`
          : 'Each term is paid in advance. Your apps switch on as soon as the first payment goes through.'}
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

      <div className="mt-5 grid gap-3 md:grid-cols-2">
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
              {plan.slug === cheapest && plans.length > 1 && (
                <Badge tone="positive" size="sm" className="absolute right-3 top-3">Best value for {form.seats} seats</Badge>
              )}
              <p className="text-md font-semibold">{plan.name}</p>
              <p className="mt-0.5 text-xs text-[var(--text-secondary)]">{plan.tagline}</p>

              <p className="mt-3 text-xl font-semibold tabular tracking-[-0.02em]">
                {money(price, plan.currency)}
                <span className="text-xs font-normal text-[var(--text-tertiary)]">
                  {' '}/ {form.cycle === 'annual' ? 'year' : 'month'} + GST
                </span>
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
          <Field label="How many people need access?" hint="Seats beyond the plan's allowance are ₹259 each per month. Change them any time.">
            {(props) => (
              <Input
                {...props}
                type="number"
                min={1}
                value={form.seats}
                onChange={(e) => {
                  const seats = Math.max(1, Math.min(100000, Number(e.target.value) || 1));
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
                    <span className="min-w-0 truncate text-[var(--text-secondary)]" title={line.detail}>{line.label}</span>
                    <span className="shrink-0 tabular">
                      {Number(line.amount) === 0 ? 'Included' : money(line.amount, 'INR')}
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
              {trialDays > 0
                ? `Free for ${trialDays} days. Pay your first term before the trial ends — early payment never shortens it. Cancel from settings any time.`
                : 'You pay the first term right after setup. Cancel from settings any time.'}
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

function Done({ name, address }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
      <div className="animate-pop flex size-14 items-center justify-center rounded-[var(--radius-2xl)] bg-[var(--color-positive-500)] text-white">
        <PartyPopper className="size-7" strokeWidth={1.75} />
      </div>
      <h1 className="mt-6 text-2xl font-semibold tracking-[-0.025em]">{name} is ready</h1>
      <p className="mt-2 max-w-sm text-md text-[var(--text-secondary)]">
        Setting up your apps and taking you to your dashboard…
      </p>
      {address && (
        <p className="mt-3 rounded-[var(--radius-md)] bg-[var(--surface-sunken)] px-3 py-1.5 font-mono text-sm">
          {address.replace(/^https?:\/\//, '').replace(/\/$/, '')}
        </p>
      )}
      <Loader2 className="mt-6 size-5 animate-spin text-[var(--text-tertiary)]" />
    </div>
  );
}
