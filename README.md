# Nexus

A modular business SaaS platform. One company account, one workspace, and a
marketplace of apps — CRM, HR, projects, inventory, invoicing, accounting,
helpdesk and more. Customers install only what they need and pay only for that.

Every app is its own service, with its own database and its own deploy.
Sign-in is shared across all of them.

---

## Quick start

```bash
pnpm install
pnpm infra:up        # postgres, redis, nats, minio, mailpit
pnpm dev             # every service + the web app
```

Then open **http://localhost:3000** and create a workspace.

```bash
pnpm smoke           # the platform: auth, tenancy, entitlements, permissions
pnpm smoke:all       # every suite — 398 assertions across seven surfaces
```

| Suite | Covers |
|---|---|
| `pnpm smoke` | sign-up, workspaces, roles, subscriptions, the three gates |
| `pnpm smoke:crm` | leads, pipeline, conversion, activities |
| `pnpm smoke:hr` | people, departments, attendance, leave, offboarding |
| `pnpm smoke:docs` | storage, versioning, spreadsheet import into CRM and HR |
| `pnpm smoke:invoicing` | GST arithmetic, numbering, payments, ageing, documents |
| `pnpm smoke:payroll` | shifts, punch terminals, overtime, PF/ESI/PT/TDS, payslips |
| `pnpm smoke:portal` | employee self-service — and everything it must **not** reach |

| | |
|---|---|
| Web app | http://localhost:3000 |
| API gateway | http://localhost:4000 |
| Mail (Mailpit) | http://localhost:8025 |
| NATS monitoring | http://localhost:8222 |
| MinIO console | http://localhost:9001 |

---

## Shape of the system

```
  Browser ──► Gateway ──► identity · tenancy · catalog · billing · crm · hr · …
                 │              each with its own Postgres database
                 │
                 └── verifies the token, resolves the tenant,
                     checks the entitlement, checks the permission
```

Three independent gates stand between a request and any business data:

1. **Authenticated** — a valid platform token, verified locally against the
   identity service's JWKS.
2. **Entitled** — billing says this workspace pays for the app.
3. **Permitted** — tenancy says this user holds the permission.

The gateway checks all three. Every service then checks them again from its own
middleware, so a gateway bug cannot become a data breach.

Read `docs/ARCHITECTURE.md` for the full design and `docs/ROADMAP.md` for what
ships in each phase.

---

## Layout

```
apps/web/           Next.js 15 · App Router · JavaScript · Tailwind v4
services/
  gateway/          the only public surface
  identity/         users, credentials, sessions — single sign-on
  tenancy/          organizations, members, roles, permissions
  catalog/          app registry and the marketplace
  billing/          plans, subscriptions, entitlements
  crm/              leads, contacts, companies, deals, activities
  hr/               people, shifts, attendance, devices, leave, reviews, letters
  payroll/          salary structures, payroll runs, payslips, statutory
  documents/        content-addressed files, versions, spreadsheet import
  invoicing/        invoices, payments, GST, receivables, invoice design
packages/
  contracts/        app registry + event catalogue, shared by every service
  service-kit/      Fastify bootstrap, guards, errors, config, logging
  db-kit/           pooled pg, migrations, transactions, outbox
  bus/              NATS JetStream + outbox relay
infra/              docker-compose for local development
scripts/            dev runner, smoke test
```

One repository, many independently deployable services. They share published
packages and HTTP/event contracts — never a runtime and never a database — so
any service can move to its own repository without a code change.

---

## Adding a new app to the platform

1. Add an entry to `packages/contracts/src/apps.js`: slug, category, price,
   features, permissions, navigation and dashboard widgets.
2. Create `services/<slug>/` with its own migrations and routes.
3. Add its database to `infra/postgres/init-databases.sh`.
4. Deploy.

The marketplace, pricing, sidebar, dashboard, permission editor and gateway
routing all update from that one registry entry. No shell code changes.

---

## Conventions

- **JavaScript only.** ESM, Node 22+. No TypeScript anywhere.
- **`org_id` on every business row**, first column of every index.
- **One error shape:** `{ error: { code, message, details, request_id } }`.
- **Forward-only migrations.** Editing an applied migration is a hard failure.
- **Domain events go through the outbox**, written in the same transaction as
  the change that caused them.
- **Never `if (user.role === 'admin')`.** Permissions, always.
- **Money in integer paise.** Never a float, and `numeric` comes back from
  Postgres as a string so it cannot round-trip through one by accident.
- **A `date` is a calendar date.** The pg driver is told to leave it as a
  `YYYY-MM-DD` string; parsing it into a local-midnight `Date` serialises a
  day early for anyone east of UTC.
- **Never join across a service boundary.** Read once over HTTP and snapshot
  what you need, or subscribe to an event and keep a projection.
- **Derived numbers are recomputed, not stored twice.** Overtime, tax and
  totals come from one pure function so a preview and the real run can never
  disagree.
