import nodemailer from 'nodemailer';
import { id } from '@nexus/db-kit';
import { EVENTS } from '@nexus/contracts/events';

/**
 * Email delivery.
 *
 * SMTP_URL (e.g. smtps://user:pass@smtp.resend.com:465, or Brevo, Gmail, SES)
 * turns real delivery on. Without it — local development — the message and
 * its link are written to the log instead, so every flow still completes.
 */
const escape = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function layout({ heading, lines, button, footer }) {
  const text = [heading, '', ...lines, '', button ? `${button.label}: ${button.url}` : '', '', footer ?? ''].join('\n').trim();
  const html = `<!doctype html><html><body style="margin:0;background:#f5f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
  <table role="presentation" width="100%" style="max-width:520px;background:#fff;border-radius:12px;padding:32px" cellpadding="0" cellspacing="0">
  <tr><td><h1 style="font-size:20px;margin:0 0 16px">${escape(heading)}</h1>
  ${lines.map((l) => `<p style="font-size:15px;line-height:1.6;margin:0 0 12px;color:#374151">${escape(l)}</p>`).join('')}
  ${button ? `<p style="margin:24px 0"><a href="${escape(button.url)}" style="background:#4f46e5;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;display:inline-block">${escape(button.label)}</a></p>
  <p style="font-size:12px;color:#6b7280;word-break:break-all">Or paste this link into your browser: ${escape(button.url)}</p>` : ''}
  ${footer ? `<p style="font-size:12px;color:#9ca3af;margin-top:24px">${escape(footer)}</p>` : ''}
  </td></tr></table></td></tr></table></body></html>`;
  return { text, html };
}

const TEMPLATES = {
  invitation: (d) => ({
    subject: `${d.inviter_name ? `${d.inviter_name} invited you` : 'You are invited'} to ${d.org_name ?? 'a workspace'} on Nexus`,
    ...layout({
      heading: `Join ${d.org_name ?? 'your team'} on Nexus`,
      lines: [
        `You have been invited${d.roles?.length ? ` as ${d.roles.join(', ')}` : ''}.`,
        ...(d.message ? [`“${d.message}”`] : []),
        'Click the button to create your account (or sign in) and add your details. The link works for 14 days.',
      ],
      button: { label: 'Accept invitation', url: d.link },
      footer: 'If you were not expecting this, you can ignore this email.',
    }),
  }),
  verify_email: (d) => ({
    subject: 'Confirm your email address',
    ...layout({ heading: `Hi ${d.name ?? 'there'}, confirm your email`, lines: ['Confirming keeps your account secure.'], button: { label: 'Confirm email', url: d.link } }),
  }),
  reset_password: (d) => ({
    subject: 'Reset your password',
    ...layout({ heading: 'Reset your password', lines: ['Someone (hopefully you) asked to reset your Nexus password. The link expires soon.'], button: { label: 'Choose a new password', url: d.link }, footer: 'If this was not you, ignore this email — your password stays the same.' }),
  }),
  magic_link: (d) => ({
    subject: 'Your sign-in link',
    ...layout({ heading: 'Sign in to Nexus', lines: ['Use this link to sign in. It works once.'], button: { label: 'Sign in', url: d.link } }),
  }),
};

export function createEmailSender({ config, db, logger }) {
  const transport = config.smtpUrl ? nodemailer.createTransport(config.smtpUrl) : null;
  if (!transport) logger.warn('SMTP_URL is not set — emails are written to the log instead of being sent');

  async function send({ eventId, to, template, data, orgId, occurredAt }) {
    const render = TEMPLATES[template];
    if (!render || !to) return;
    // A link that old has expired anyway; never mail stale history.
    if (occurredAt && Date.now() - new Date(occurredAt).getTime() > 24 * 3_600_000) return;
    // Claim the (event, address) first: a redelivery finds it taken and stops.
    const claimed = await db.one(
      `INSERT INTO emails (id, event_id, to_address, template, org_id, status)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (event_id, to_address) DO NOTHING RETURNING id`,
      [id('eml'), eventId, to.toLowerCase(), template, orgId ?? null, transport ? 'sent' : 'logged'],
    );
    if (!claimed) return;

    const message = render(data ?? {});
    if (!transport) {
      logger.info(`\n  ✉  ${template} → ${to}\n     ${message.subject}\n     ${data?.link ?? ''}\n`);
      return;
    }
    try {
      const info = await transport.sendMail({ from: config.mailFrom, to, subject: message.subject, text: message.text, html: message.html });
      await db.query(`UPDATE emails SET provider_id = $2 WHERE id = $1`, [claimed.id, info.messageId ?? null]);
    } catch (error) {
      // Release the claim so the bus retry can try again.
      await db.query(`DELETE FROM emails WHERE id = $1`, [claimed.id]);
      throw error;
    }
  }

  return {
    async register(bus) {
      // `from: 'new'`: a freshly deployed sender must not work through the
      // retained backlog and re-send every past invitation.
      await bus.subscribe('notifier-email', EVENTS.MEMBER_INVITED, async (event) => {
        const d = event.data ?? {};
        await send({ eventId: event.id, to: d.email, template: 'invitation', data: d, orgId: event.org_id, occurredAt: event.occurred_at });
      }, { from: 'new' });
      await bus.subscribe('notifier-email', EVENTS.NOTIFICATION_REQUESTED, async (event) => {
        const d = event.data ?? {};
        if (d.channel !== 'email') return;
        await send({ eventId: event.id, to: d.to, template: d.template, data: { ...(d.payload ?? {}) }, orgId: event.org_id, occurredAt: event.occurred_at });
      }, { from: 'new' });
    },
  };
}
