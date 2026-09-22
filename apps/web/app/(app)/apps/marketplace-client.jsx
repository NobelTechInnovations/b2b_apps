'use client';

import { useMemo, useState } from 'react';
import { Search, Check, Plus, Sparkles, Lock, AlertTriangle, ArrowRight } from 'lucide-react';
import { cn } from '@/lib/cn';
import { api, ApiError } from '@/lib/api';
import { money } from '@/lib/format';
import { useWorkspace } from '@/lib/workspace';
import { useToast } from '@/components/ui/toast';
import { Card, Badge, PageHeader, EmptyState, Alert } from '@/components/ui/primitives';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Icon, tintFor } from '@/components/shell/icon';

/**
 * The marketplace. Every card knows three independent things: is this app
 * available, does the workspace pay for it, and is it switched on. The copy
 * changes accordingly rather than showing one generic "Install" button.
 */
export default function MarketplaceClient({ initialApps, meta }) {
  const toast = useToast();
  const { reload, can } = useWorkspace();

  const [apps, setApps] = useState(initialApps);
  const [category, setCategory] = useState('all');
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState(null);
  const [confirming, setConfirming] = useState(null);

  const manageable = can('catalog.apps.manage');

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return apps.filter((app) => {
      if (category !== 'all' && app.category !== category) return false;
      if (!needle) return true;
      return (
        app.name.toLowerCase().includes(needle) ||
        app.tagline?.toLowerCase().includes(needle) ||
        app.description?.toLowerCase().includes(needle)
      );
    });
  }, [apps, category, query]);

  async function addToSubscription(app) {
    setPending(app.slug);
    try {
      // Adding it to the subscription is what grants it; billing provisions
      // the install itself. A second install call here would race that.
      await api.post('/subscriptions/current/apps', { app_slug: app.slug });

      setApps((current) =>
        current.map((a) =>
          a.slug === app.slug || (app.requires ?? []).includes(a.slug)
            ? { ...a, installed: true, entitled: true, requires: [] }
            : a,
        ),
      );

      toast.success(`${app.name} is ready`, {
        description: (app.requires ?? []).length
          ? `We also switched on ${app.requires.join(', ')}, which it needs.`
          : 'It is now in your sidebar.',
      });
      await reload();
    } catch (error) {
      toast.error('Could not add that app', {
        description: error instanceof ApiError ? error.message : 'Please try again.',
      });
    } finally {
      setPending(null);
      setConfirming(null);
    }
  }

  async function removeApp(app) {
    setPending(app.slug);
    try {
      // Likewise, dropping the subscription item is what removes the app.
      await api.del(`/subscriptions/current/apps/${app.slug}`);

      setApps((current) =>
        current.map((a) => (a.slug === app.slug ? { ...a, installed: false, entitled: false } : a)),
      );
      toast.success(`${app.name} removed`, {
        description: 'Your data is kept for 30 days in case you change your mind.',
      });
      await reload();
    } catch (error) {
      toast.error('Could not remove that app', {
        description: error instanceof ApiError ? error.message : 'Please try again.',
      });
    } finally {
      setPending(null);
      setConfirming(null);
    }
  }

  const categories = [{ slug: 'all', name: 'All apps', count: apps.length }, ...(meta.categories ?? [])];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Apps"
        description="Switch on what your business needs. Add or remove any time — you are only billed for what is active."
        actions={
          <Badge tone="brand" dot>
            {apps.filter((a) => a.installed).length} active
          </Badge>
        }
      />

      {!manageable && (
        <Alert tone="info" icon={Lock}>
          You can browse the marketplace, but only an owner or admin can add and remove apps.
        </Alert>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Input
          icon={Search}
          placeholder="Search apps…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="max-w-xs"
        />
        <div className="flex flex-wrap gap-1.5">
          {categories.map((c) => (
            <button
              key={c.slug}
              onClick={() => setCategory(c.slug)}
              className={cn(
                'rounded-full px-3 py-1.5 text-sm font-medium transition-colors',
                category === c.slug
                  ? 'bg-[var(--surface-inverse)] text-[var(--text-inverse)]'
                  : 'bg-[var(--surface-raised)] text-[var(--text-secondary)] ring-1 ring-inset ring-[var(--border-subtle)] hover:bg-[var(--surface-hover)]',
              )}
            >
              {c.name}
              {c.count !== undefined && (
                <span className="ml-1.5 opacity-55 tabular">{c.count}</span>
              )}
            </button>
          ))}
        </div>
      </div>

      {visible.length === 0 ? (
        <Card>
          <EmptyState icon={Search} title="No apps match that" description="Try a different search or category." />
        </Card>
      ) : (
        <div className="stagger grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((app) => (
            <AppCard
              key={app.slug}
              app={app}
              currency={meta.currency ?? 'INR'}
              busy={pending === app.slug}
              manageable={manageable}
              onAdd={() => setConfirming({ app, action: 'add' })}
              onRemove={() => setConfirming({ app, action: 'remove' })}
            />
          ))}
        </div>
      )}

      <ConfirmDialog
        state={confirming}
        currency={meta.currency ?? 'INR'}
        busy={Boolean(pending)}
        onClose={() => setConfirming(null)}
        onConfirm={() =>
          confirming.action === 'add' ? addToSubscription(confirming.app) : removeApp(confirming.app)
        }
      />
    </div>
  );
}

function AppCard({ app, currency, busy, manageable, onAdd, onRemove }) {
  const comingSoon = app.status === 'coming_soon';

  return (
    <Card className={cn('flex flex-col p-5', comingSoon && 'opacity-70')}>
      <div className="flex items-start gap-3">
        <span className={cn('flex size-10 shrink-0 items-center justify-center rounded-[var(--radius-lg)]', tintFor(app.color))}>
          <Icon name={app.icon} className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-md font-semibold">{app.name}</h3>
            {app.installed && <Badge tone="positive" size="sm">Active</Badge>}
            {comingSoon && <Badge tone="neutral" size="sm">Soon</Badge>}
          </div>
          <p className="mt-0.5 line-clamp-1 text-sm text-[var(--text-secondary)]">{app.tagline}</p>
        </div>
      </div>

      <p className="mt-3.5 line-clamp-2 text-sm leading-relaxed text-[var(--text-secondary)]">
        {app.description}
      </p>

      {app.highlights?.length > 0 && (
        <ul className="mt-3.5 space-y-1.5">
          {app.highlights.slice(0, 3).map((highlight) => (
            <li key={highlight} className="flex items-start gap-2 text-sm text-[var(--text-secondary)]">
              <Check className="mt-0.5 size-3.5 shrink-0 text-[var(--color-positive-500)]" strokeWidth={2.5} />
              <span className="min-w-0">{highlight}</span>
            </li>
          ))}
        </ul>
      )}

      {app.requires?.length > 0 && !app.installed && (
        <p className="mt-3 flex items-start gap-1.5 text-xs text-[var(--color-caution-600)]">
          <AlertTriangle className="mt-px size-3.5 shrink-0" />
          <span>Also switches on {app.requires.join(', ')}</span>
        </p>
      )}

      <div className="mt-auto flex items-end justify-between gap-3 pt-5">
        <div>
          <p className="text-lg font-semibold tabular tracking-[-0.02em]">
            {app.price?.monthly === 0 ? 'Free' : money(app.price?.monthly, app.price?.currency ?? currency)}
          </p>
          {app.price?.monthly > 0 && (
            <p className="text-2xs text-[var(--text-tertiary)]">
              per {app.price.per === 'user' ? 'user' : 'workspace'} / month
            </p>
          )}
        </div>

        {comingSoon ? (
          <Button variant="ghost" size="sm" disabled>Coming soon</Button>
        ) : app.installed ? (
          <Button variant="ghost" size="sm" onClick={onRemove} loading={busy} disabled={!manageable}>
            Remove
          </Button>
        ) : (
          <Button variant="primary" size="sm" icon={Plus} onClick={onAdd} loading={busy} disabled={!manageable}>
            Add
          </Button>
        )}
      </div>
    </Card>
  );
}

function ConfirmDialog({ state, currency, busy, onClose, onConfirm }) {
  if (!state) return null;
  const { app, action } = state;
  const adding = action === 'add';

  return (
    <Modal
      open
      onClose={onClose}
      title={adding ? `Add ${app.name}?` : `Remove ${app.name}?`}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button
            variant={adding ? 'primary' : 'danger'}
            onClick={onConfirm}
            loading={busy}
            iconRight={adding ? ArrowRight : undefined}
            data-autofocus
          >
            {adding ? 'Add to subscription' : 'Remove app'}
          </Button>
        </>
      }
    >
      {adding ? (
        <div className="space-y-3 text-base text-[var(--text-secondary)]">
          <p>
            {app.name} will be switched on immediately and appear in your sidebar
            for everyone with the right permissions.
          </p>
          {app.requires?.length > 0 && (
            <Alert tone="caution" icon={AlertTriangle}>
              {app.name} needs {app.requires.join(' and ')}, so {app.requires.length === 1 ? 'that will' : 'those will'} be added too.
            </Alert>
          )}
          <div className="flex items-center justify-between rounded-[var(--radius-lg)] bg-[var(--surface-sunken)] px-3.5 py-3">
            <span className="text-sm">Added to your next invoice</span>
            <span className="text-md font-semibold tabular">
              {app.price?.monthly === 0
                ? 'Free'
                : `${money(app.price?.monthly, app.price?.currency ?? currency)} / ${app.price?.per === 'user' ? 'user' : 'workspace'}`}
            </span>
          </div>
          <p className="flex items-start gap-1.5 text-xs text-[var(--text-tertiary)]">
            <Sparkles className="mt-px size-3.5 shrink-0" />
            You are within your trial, so nothing is charged today.
          </p>
        </div>
      ) : (
        <div className="space-y-3 text-base text-[var(--text-secondary)]">
          <p>
            {app.name} will disappear from the sidebar and its API will stop
            accepting requests for this workspace.
          </p>
          <Alert tone="info">
            Your data is kept for 30 days. Add the app back within that window and
            everything returns exactly as it was.
          </Alert>
        </div>
      )}
    </Modal>
  );
}
