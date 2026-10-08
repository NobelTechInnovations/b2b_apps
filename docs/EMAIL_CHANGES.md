# Sign-in email changes

- Workspace users: Settings > Your profile > Change sign-in email.
- Portal employees: open the name menu > Your profile.
- Owners/admins: Settings > People > person actions > Change sign-in email.

The requester supplies their own current password. A confirmation message is
queued to the new address and a security notice to the current address. The
current login stays active until the recipient explicitly confirms the new
address. Links expire after 24 hours; resending replaces the previous link.
Pending changes can be canceled from the same form, including by the employee
when an administrator initiated the request.

On confirmation, identity updates `users.email`, `email_normalized`, and
`email_verified_at` in one transaction with token invalidation, session
revocation, and outbox events. Sign in again using the new email and existing
password. User IDs, memberships, roles, payroll and employee IDs stay unchanged.
Password changes/resets cancel pending changes initiated by or targeting that
account. Duplicate addresses are rejected both at request and confirmation.

An administrator must currently hold the owner role, or the admin role with
`core.members.edit`. Both requester and target must be active in the workspace.
Owners change their own addresses. Accounts belonging to other workspaces must
also use self-service: one organization's administrator cannot take control of
another organization's login. Authority is checked again at confirmation.

HR work/personal contact emails are separate employment data and are **not**
overwritten by a sign-in email change. HR administrators can continue editing
those fields in the employee form. Historical invitations retain their original
recipient. This feature changes existing accounts, not pending invite recipients.

## Deployment

Deploy identity, tenancy and notifier together, then deploy the frontend.
Identity's normal startup migrations apply `0004_email_changes.sql`; do not
edit previously applied migrations. Requests are stored in
`nexus_identity.email_change_requests` with the default production schema prefix.
No new environment variables are required. The existing `APP_URL` must point to
the frontend; the outbox relay, event bus and notifier mail transport must be
running for confirmation messages to arrive. Email delivery failure never
changes the current login address. No production data is modified by the tests.

## Tests

`node --test tests/email-change.test.js` uses in-memory PostgreSQL (PGlite), the
actual identity/tenancy migrations, Fastify routes, password hashing and signing
keys. It covers authorization, request/cancel/confirm, conflicts, expiry, replay,
session and token invalidation, transaction rollback, recovery and new-address
login. It does not contact Supabase or send real email.
