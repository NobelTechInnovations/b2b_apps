/**
 * Identity does not send email. It asks the notifier service to, by writing a
 * request onto the bus — so delivery, retries, templates and preferences all
 * live in one place instead of being reimplemented in every service.
 *
 * In development the link is also printed, so you can complete a flow without
 * opening a mail client.
 */
import { id } from '@nexus/db-kit';
import { EVENTS } from '@nexus/contracts/events';

const SUBJECTS = {
  verify_email: 'Confirm your email address',
  reset_password: 'Reset your password',
  magic_link: 'Your sign-in link',
};

export function createMailer({ db, logger, isDev }) {
  return {
    async send(template, { to, name, link, ...data }) {
      await db.query(
        `INSERT INTO outbox (id, type, data) VALUES ($1, $2, $3)`,
        [
          id('evt'),
          EVENTS.NOTIFICATION_REQUESTED,
          JSON.stringify({
            channel: 'email',
            template,
            to,
            subject: SUBJECTS[template] ?? 'Notification',
            payload: { name, link, ...data },
          }),
        ],
      );

      if (isDev && link) {
        logger.info(`\n  ✉  ${template} → ${to}\n     ${link}\n`);
      }
    },
  };
}
