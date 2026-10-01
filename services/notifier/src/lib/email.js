import os from 'node:os';
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

  // ── messages a workspace sends its own customers ─────────────────────────
  quote: (d) => ({
    subject: `Quotation ${d.number} from ${d.company}`,
    ...layout({
      heading: `Your quotation from ${d.company}`,
      lines: [`Hello ${d.customer ?? ''},`.replace(' ,', ','), `Here is quotation ${d.number} for ₹${Number(d.total).toLocaleString('en-IN', { minimumFractionDigits: 2 })}, valid until ${d.valid_until}.`, 'You can accept or decline it online.'],
      button: { label: 'View quotation', url: d.link },
    }),
  }),
  campaign: (d) => {
    const body = layout({ heading: d.heading ?? d.subject, lines: String(d.text ?? '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean), button: d.button, footer: `You are receiving this from ${d.company}. Unsubscribe: ${d.unsubscribe_url}` });
    // An invisible image records the open; the unsubscribe link is always there.
    const pixel = d.pixel_url ? `<img src="${escape(d.pixel_url)}" width="1" height="1" alt="" style="display:block;border:0">` : '';
    return { subject: d.subject, text: body.text, html: body.html.replace('</body>', `${pixel}</body>`) };
  },
  sign_request: (d) => ({
    subject: `${d.sender} sent you “${d.title}” to sign`,
    ...layout({ heading: `Please sign “${d.title}”`, lines: [...(d.message ? [`“${d.message}”`] : []), `${d.sender} is using Nexus E-Signature. Review the document and sign it online — it takes a minute.`], button: { label: 'Review and sign', url: d.link }, footer: d.expires_on ? `This request expires on ${d.expires_on}.` : undefined }),
  }),
  booking_confirmation: (d) => ({
    subject: `Confirmed: ${d.title} on ${d.when}`,
    ...layout({ heading: 'Your booking is confirmed', lines: [`${d.title} with ${d.host} on ${d.when}.`, ...(d.location ? [`Where: ${d.location}`] : [])], footer: 'Need to change it? Reply to this email.' }),
  }),
  test: (d) => ({
    subject: 'Test email from Nexus',
    ...layout({
      heading: 'Your email settings work',
      lines: [`This test was sent by ${d.requested_by ?? 'an administrator'} for ${d.org_name ?? 'your workspace'}.`, `Mail service: ${d.transport}. Server: ${d.server}.`],
      footer: 'Nothing to do — this only confirms invitations and password resets can reach people.',
    }),
  }),
  partner_portal: (d) => ({
    subject: `Your ${d.company} partner portal`,
    ...layout({ heading: `Welcome to the ${d.company} partner programme`, lines: ['Register deals, track their progress and see your commissions from your own portal. Keep this link private — it is your key.'], button: { label: 'Open the partner portal', url: d.link } }),
  }),
};

export function smtpTransport(config) {
  if (config.smtpUrl) return nodemailer.createTransport(config.smtpUrl);
  if (!config.smtpHost) return null;
  return nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    // 465 is TLS from the first byte; 587 upgrades with STARTTLS, and we
    // insist on it so credentials never cross the wire in the clear.
    secure: config.smtpPort === 465,
    requireTLS: config.smtpPort !== 465,
    auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPass } : undefined,
  });
}

// Domains reserved for testing and documentation (RFC 2606 / RFC 6761). Mail
// to them can only bounce, and bounces cost the sending domain its reputation,
// so test runs and demo seeds are logged instead of handed to the provider.
const RESERVED = /(^|\.)(test|example|invalid|localhost)$|(^|\.)example\.(com|net|org)$/i;

/** Which mail service this server would use: `smtp.zeptomail.in:587`, or null. */
export function transportLabel(config) {
  if (config.smtpUrl) {
    try {
      const url = new URL(config.smtpUrl);
      return `${url.hostname}:${url.port || (url.protocol === 'smtps:' ? 465 : 587)}`;
    } catch {
      return 'SMTP_URL';
    }
  }
  return config.smtpHost ? `${config.smtpHost}:${config.smtpPort}` : null;
}

const SERVER = os.hostname();

export function createEmailSender({ config, db, logger }) {
  const transport = smtpTransport(config);
  const label = transportLabel(config);
  if (!transport) logger.warn('SMTP is not configured — emails are written to the log instead of being sent');

  /**
   * Send one email and keep a record of what happened: sent (with the
   * provider's reply), failed (with its error), retrying, or only logged —
   * and on which server, through which mail service.
   */
  async function send({ eventId, to, template, data, orgId, occurredAt, retry = true }) {
    const render = TEMPLATES[template];
    if (!render || !to) return null;
    // A link that old has expired anyway; never mail stale history.
    if (occurredAt && Date.now() - new Date(occurredAt).getTime() > 24 * 3_600_000) return null;
    const reserved = RESERVED.test(to.split('@')[1] ?? '');
    const deliver = Boolean(transport) && !reserved;
    const message = render(data ?? {});
    const why = reserved
      ? 'Test address: never sent, only written to the log.'
      : `This server (${SERVER}) has no SMTP settings, so the email was written to its log instead of being sent.`;
    // Claim the (event, address) first: a redelivery finds it taken and stops,
    // unless the earlier attempt is waiting to be retried.
    const claimed = await db.one(
      `INSERT INTO emails (id, event_id, to_address, template, org_id, status, subject, server, transport, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (event_id, to_address) DO UPDATE
         SET attempts = emails.attempts + 1, status = EXCLUDED.status, server = EXCLUDED.server,
             transport = EXCLUDED.transport, updated_at = now()
         WHERE emails.status = 'retrying'
       RETURNING id`,
      [id('eml'), eventId, to.toLowerCase(), template, orgId ?? null, deliver ? 'sending' : 'logged',
        String(message.subject ?? '').slice(0, 300), SERVER, label ?? 'none', deliver ? null : why],
    );
    if (!claimed) return null;

    if (!deliver) {
      logger.info(`\n  ✉  ${template} → ${to}\n     ${message.subject}\n     ${data?.link ?? ''}\n`);
      return { id: claimed.id, status: 'logged', error: why, transport: label, server: SERVER };
    }
    try {
      const info = await transport.sendMail({ from: config.mailFrom, to, subject: message.subject, text: message.text, html: message.html });
      const reply = String(info.response ?? '').slice(0, 500);
      await db.query(
        `UPDATE emails SET status = 'sent', provider_id = $2, response = $3, error = NULL, updated_at = now() WHERE id = $1`,
        [claimed.id, info.messageId ?? null, reply],
      );
      return { id: claimed.id, status: 'sent', response: reply, transport: label, server: SERVER };
    } catch (error) {
      const detail = String(error.response ?? error.message ?? error).slice(0, 500);
      // A 5xx is the provider saying "never": an unverified sender, wrong
      // credentials, a mailbox that does not exist. Retrying cannot help and
      // only holds up the queue, so record why and move on.
      const permanent = (error.responseCode >= 500 && error.responseCode < 600) || error.code === 'EAUTH';
      await db.query(
        `UPDATE emails SET status = $2, error = $3, updated_at = now() WHERE id = $1`,
        [claimed.id, permanent || !retry ? 'failed' : 'retrying', detail],
      );
      if (permanent || !retry) {
        logger.error({ template, code: error.responseCode ?? error.code, response: error.response }, 'email rejected by the mail provider');
        return { id: claimed.id, status: 'failed', error: detail, transport: label, server: SERVER };
      }
      // Anything else (a timeout, a dropped connection) may pass on a retry.
      throw error;
    }
  }

  /** Send a test message now and say exactly what the mail service answered. */
  async function sendTest({ to, orgId, data }) {
    return send({ eventId: `test_${id('evt')}`, to, template: 'test', data: { ...data, transport: label ?? 'none', server: SERVER }, orgId, retry: false });
  }

  return {
    send,
    sendTest,
    transport: label,
    server: SERVER,
    from: config.mailFrom,
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
