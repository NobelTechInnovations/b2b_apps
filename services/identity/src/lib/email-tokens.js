import { badRequest } from '@nexus/service-kit';

/** Serialize recovery/verification with address changes; old-mailbox tokens cannot win a race. */
export async function consumeCurrentEmailToken(tx, record) {
  const user = await tx.one(`SELECT email_normalized FROM users WHERE id = $1 AND status = 'active' FOR UPDATE`, [record.user_id]);
  if (!user || user.email_normalized !== record.email.toLowerCase()) {
    throw badRequest('That link is invalid or expired. Request a new one.');
  }
  const consumed = await tx.one(
    `UPDATE email_tokens SET consumed_at = now()
     WHERE id = $1 AND consumed_at IS NULL AND expires_at > now() RETURNING id`, [record.id],
  );
  if (!consumed) throw badRequest('That link is invalid or expired. Request a new one.');
}
