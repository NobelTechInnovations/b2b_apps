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
pnpm smoke           # end-to-end check of the whole platform
```

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
