import { APPS } from '@nexus/contracts';
import { Hero } from '@/components/marketing/hero';
import { AppUniverse } from '@/components/marketing/app-universe';
import { ValueProps } from '@/components/marketing/value-props';
import { HowItWorks } from '@/components/marketing/how-it-works';
import { PricingTeaser } from '@/components/marketing/pricing-teaser';
import { ClosingCta } from '@/components/marketing/closing-cta';

export const metadata = {
  title: 'Nexus — the business platform you assemble yourself',
  description:
    'CRM, HR, inventory, invoicing, accounting, helpdesk and more. Pick only the apps your business needs, on one workspace with one login and one bill.',
};

export default function HomePage() {
  const liveApps = APPS.filter((a) => !a.core && a.status !== 'coming_soon').length;

  return (
    <>
      <Hero liveApps={liveApps} />
      <ValueProps />
      <AppUniverse />
      <HowItWorks />
      <PricingTeaser />
      <ClosingCta />
    </>
  );
}
