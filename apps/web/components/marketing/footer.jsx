import Link from 'next/link';
import { APP_CATEGORIES, appsByCategory } from '@nexus/contracts';
import { Wordmark } from '@/components/brand';

const COLUMNS = [
  {
    title: 'Product',
    links: [
      { label: 'All apps', href: '/apps-directory' },
      { label: 'Pricing', href: '/pricing' },
      { label: 'What’s new', href: '/changelog' },
      { label: 'Security', href: '/security' },
    ],
  },
  {
    title: 'Company',
    links: [
      { label: 'About', href: '/about' },
      { label: 'Customers', href: '/customers' },
      { label: 'Partners', href: '/partners-program' },
      { label: 'Careers', href: '/careers' },
    ],
  },
  {
    title: 'Resources',
    links: [
      { label: 'Documentation', href: '/docs' },
      { label: 'API reference', href: '/docs/api' },
      { label: 'Help centre', href: '/help' },
      { label: 'Status', href: '/status' },
    ],
  },
];

export function MarketingFooter() {
  const featured = APP_CATEGORIES.slice(0, 4);

  return (
    <footer className="border-t border-[var(--border-subtle)] bg-[var(--surface-raised)]">
      <div className="mx-auto max-w-6xl px-5 py-14 lg:px-8">
        <div className="grid gap-10 lg:grid-cols-[1.4fr_repeat(3,1fr)]">
          <div>
            <Wordmark />
            <p className="mt-3 max-w-xs text-sm leading-relaxed text-[var(--text-secondary)]">
              The business platform you assemble yourself. Start with one app,
              add the rest when you are ready — same people, same customers,
              same login.
            </p>
            <p className="mt-5 text-xs text-[var(--text-tertiary)]">
              Made for businesses in India 🇮🇳 · GST-ready out of the box
            </p>
          </div>

          {COLUMNS.map((column) => (
            <div key={column.title}>
              <p className="text-sm font-semibold">{column.title}</p>
              <ul className="mt-3 space-y-2">
                {column.links.map((link) => (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      className="text-sm text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-12 grid gap-6 border-t border-[var(--border-subtle)] pt-8 sm:grid-cols-2 lg:grid-cols-4">
          {featured.map((category) => (
            <div key={category.slug}>
              <p className="text-2xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
                {category.name}
              </p>
              <ul className="mt-2 space-y-1">
                {appsByCategory(category.slug).slice(0, 5).map((app) => (
                  <li key={app.slug}>
                    <Link
                      href={`/apps-directory#${app.slug}`}
                      className="text-xs text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-secondary)]"
                    >
                      {app.name}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-10 flex flex-wrap items-center justify-between gap-4 border-t border-[var(--border-subtle)] pt-6">
          <p className="text-xs text-[var(--text-tertiary)]">
            © {new Date().getFullYear()} Nexus. All rights reserved.
          </p>
          <div className="flex flex-wrap gap-5">
            {['Privacy', 'Terms', 'Cookies', 'DPA'].map((item) => (
              <Link
                key={item}
                href={`/${item.toLowerCase()}`}
                className="text-xs text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-secondary)]"
              >
                {item}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </footer>
  );
}
