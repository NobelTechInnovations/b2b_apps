import { notFound } from 'next/navigation';
import { appBySlug } from '@nexus/contracts';
import { serverApi } from '@/lib/server-api';
import AppPlaceholder from './placeholder';

/**
 * Catch-all for app routes that have no screens yet.
 *
 * Explicit routes (/dashboard, /apps, /settings, /crm…) take precedence in the
 * App Router, so this only ever runs for an app whose UI is still being built.
 * Without it, the marketplace would sell an app, install it, put it in the
 * sidebar — and then 404 when someone clicked it.
 */
export async function generateMetadata({ params }) {
  const { appRoute } = await params;
  const app = appBySlug(appRoute?.[0]);
  return { title: app?.name ?? 'Not found' };
}

export default async function AppRoutePage({ params }) {
  const { appRoute } = await params;
  const slug = appRoute?.[0];
  const app = appBySlug(slug);

  // Not an app at all — a genuine wrong URL.
  if (!app || app.core) notFound();

  const { data } = await serverApi('/me/workspace');
  const entitled = data?.apps?.includes(slug) ?? false;
  const installed = data?.installed?.includes(slug) ?? false;

  return <AppPlaceholder app={app} entitled={entitled} installed={installed} />;
}
