# Nexus Platform — Build Roadmap

Ships one phase at a time. Each phase is independently demoable and leaves the
platform in a working state.

---

## Phase 0 — Architecture ✅
`docs/ARCHITECTURE.md`. Topology, tenancy, SSO, entitlements, event contracts,
data ownership.

## Phase 1 — Foundation 🔨 (in progress)
Infrastructure and the seams every service depends on.
- `infra/docker-compose.yml` — Postgres, Redis, NATS JetStream, MinIO, Mailpit
- `packages/service-kit` — Fastify bootstrap, config schema, error envelope,
  auth guard, tenant guard, permission guard, health probes, logging
- `packages/db-kit` — pooled pg client, forward-only migration runner,
  transaction helper, tenant-scoped query builder, outbox writer
- `packages/bus` — NATS publish/subscribe, outbox relay, idempotent consumers
- `packages/contracts` — event envelope + per-domain event schemas

## Phase 2 — Identity (SSO)
`services/identity` — the single sign-in for every app.
- signup, login, logout, refresh with rotation, session listing + revoke
- argon2id credentials, RS256 JWT signing, published JWKS
- email verification, password reset, invitation acceptance
- org switching, membership epoch revocation
- ready for TOTP / passkeys / OIDC / SAML without route changes

## Phase 3 — Tenancy
`services/tenancy` — organizations, members, roles, permissions, teams,
invitations, org settings, the permission registry itself.

## Phase 4 — Catalog + Billing (the commercial engine)
- `services/catalog` — app registry, categories, marketplace, install /
  uninstall, dependency resolution, per-app settings
- `services/billing` — plans, per-app pricing, subscriptions, subscription
  items, app + feature entitlements, trials, upgrade / downgrade / cancel,
  invoices, the Redis entitlement projection

## Phase 5 — Gateway
`services/gateway` — the only public surface. Token verification, tenant
resolution, entitlement + permission enforcement, rate limiting, request
audit, service routing, `GET /me/workspace`.

## Phase 6 — Web shell
`apps/web` — Next.js. Auth flows, onboarding wizard (industry → size → app
selection → plan → workspace), dynamic sidebar, modular dashboard, app
marketplace, settings, command palette, the full design system.

## The app catalogue

39 apps across 13 categories. Every entry below is already live in
`packages/contracts/src/apps.js` — the marketplace, pricing, sidebar, dashboard
widgets, permission editor and gateway routing are all generated from it.

Apps marked *(planned)* appear in the marketplace as "Coming soon": they are
priced and described, but cannot yet be installed.

### Sales

- **CRM** — Leads, deals and the pipeline that closes them
- **Quotations & Orders** — From quote to signed order — needs crm
- **Partner Portal** — Sell through your channel — needs crm *(planned)*

### Marketing

- **Marketing** — Campaigns that fill the pipeline — needs crm
- **Social** — One inbox for every channel *(planned)*
- **Surveys & Forms** — Ask, and actually use the answers

### Commerce & POS

- **Online Store** — Your storefront, wired to your stock — needs erp
- **Point of Sale** — Counter sales that keep working offline — needs erp
- **Recurring Billing** — Recurring revenue, handled — needs invoicing *(planned)*

### Customer Service

- **Helpdesk** — Every customer issue, answered
- **Field Service** — Dispatch, track, close the job — needs helpdesk *(planned)*
- **Knowledge Base** — The answers, written down once

### Finance

- **Invoicing** — Get paid, on time
- **Accounting** — A real general ledger, not a spreadsheet — needs invoicing
- **Expenses** — Claims without the paper chase
- **Asset Management** — Know what you own and what it is worth — needs accounting *(planned)*

### Operations

- **Inventory & Purchasing** — Products, stock and suppliers
- **Manufacturing** — From bill of materials to finished goods — needs erp
- **Quality** — Catch it before the customer does — needs erp *(planned)*
- **Maintenance** — Keep the machines running *(planned)*

### Human Resources

- **HR** — Your whole team, from offer letter to exit
- **Payroll** — Salaries, statutory and payslips — needs hr
- **Recruitment** — From job post to joining date — needs hr
- **Learning** — Train the team, prove the training — needs hr *(planned)*

### Project Management

- **Projects & Tasks** — Everything the team is working on
- **Resource Planning** — Who is free, and when — needs tasks

### Email, Storage & Collaboration

- **Documents** — One place for every file
- **Mail** — Business email on your own domain *(planned)*
- **Discuss** — Team chat that knows your records *(planned)*
- **Calendar & Meetings** — Shared calendars and booking pages *(planned)*
- **E-Signature** — Signed, sealed, audited — needs documents

### Legal

- **Contracts** — Never miss a renewal again — needs documents
- **Compliance** — Evidence, not hope *(planned)*

### Security & IT

- **Identity & Access** — SSO, MFA and who touched what
- **Device Management** — Every laptop accounted for — needs hr *(planned)*

### BI & Analytics

- **Business Intelligence** — Every app, one set of numbers

### Developer Platform

- **Automation** — If this, then that — across every app
- **Integrations** — Connect the tools you already pay for

---

## Phase 7 — Shared services
`files`, `notifier`, `search`, `audit`. Attachments, in-app feed and email,
cross-app search, immutable action log.

## Phase 8 — CRM
Leads, contacts, companies, deals, pipeline (drag-drop), activities, calls,
meetings, follow-ups, notes. **System of record for `customer`.**

## Phase 9 — HR + Employee Management
Employees, departments, designations, attendance, leave, documents,
performance, goals, assets, announcements.

## Phase 10 — Tasks + Projects
Projects, tasks, subtasks, kanban, calendar, milestones, time tracking,
comments, attachments. Cross-app task creation from CRM / HR / Helpdesk.

## Phase 11 — ERP
Products, categories, inventory, warehouses, purchase, sales, vendors, stock
transfers and adjustments. **System of record for `product` and `stock`.**

## Phase 12 — Billing app + Accounting
Invoices, recurring billing, payments, credit notes, taxes → then chart of
accounts, journal entries, ledger, AR/AP, bank, cash, expenses, P&L, balance
sheet, trial balance. Transactions flow in by event from sales, purchase,
billing and expenses.

## Phase 13 — Helpdesk + Knowledge
Tickets, teams, agents, SLA, canned responses, customer portal, knowledge base,
spaces, articles, public KB.

## Phase 14 — Documents + Discuss
Folders, sharing, versioning, approvals; channels, DMs, mentions.

## Phase 15 — Manufacturing
BOM, manufacturing orders, work centers, work orders, production planning,
material consumption, finished goods, scrap, quality.

## Phase 16 — BI
Dashboards, charts, KPIs, reports, filters, drilldowns, scheduled reports,
export. Reads from a per-app analytics projection, never from live app tables.

## Phase 17 — Automation
Trigger → conditions → actions, running off the event bus. Visual builder.

## Phase 18 — Integrations
WhatsApp, email, Google, Microsoft, Shopify, WooCommerce, payment gateways,
shipping, calendar, storage.

## Phase 19 — AI assistant
Natural-language queries and actions over the declared capability descriptors,
respecting org, entitlement and permission boundaries.

---

## First sellable MVP

Phases 1–10: **Platform core + CRM + HR + Tasks + Dashboard + Marketplace.**
That is a product a business can buy, not a demo.
