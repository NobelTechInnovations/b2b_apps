import { appBySlug } from '@nexus/contracts';
import { serverApi } from '@/lib/server-api';
import DashboardClient from './dashboard-client';

export const metadata = { title: 'Dashboard' };

export default async function DashboardPage() {
  const [workspace, organization] = await Promise.all([
    serverApi('/me/workspace'),
    serverApi('/organizations/current'),
  ]);

  // Widget data comes from whichever apps the workspace actually has, in
  // parallel. A slow or missing app degrades its own tiles, not the page.
  const apps = workspace.data?.apps ?? [];
  // Every app that declares widgets serves them at /<app>/widgets.
  const widgetSources = apps.filter((slug) => appBySlug(slug)?.widgets?.length);

  const widgetResults = await Promise.all(
    widgetSources.map(async (slug) => {
      const { data } = await serverApi(`/${slug}/widgets`);
      return data ?? {};
    }),
  );

  const widgetData = Object.assign({}, ...widgetResults);

  return (
    <DashboardClient
      workspace={workspace.data}
      organization={organization.data}
      widgetData={widgetData}
    />
  );
}
