import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import nodemailer from 'nodemailer';
import { TIMEOUTS } from './email.js';

/**
 * A workspace's own mail server: Gmail, Google Workspace, Zoho Mail, or the
 * mailbox their web host gives them. Its emails go out through it, from its
 * own address, instead of through the server-wide settings.
 */

// ── the password at rest ─────────────────────────────────────────────────────
// Sealed with a key derived from the service token: rotating that token means
// entering the mail password again.
let key = null;
const keyFor = (serviceToken) => (key ??= scryptSync(serviceToken, 'nexus-mail-settings', 32));

export function sealPassword(plain, serviceToken) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFor(serviceToken), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}

export function openPassword(sealed, serviceToken) {
  try {
    const [iv, tag, data] = sealed.split('.').map((part) => Buffer.from(part, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', keyFor(serviceToken), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** The address emails come from: `FLP Worldwide <info@flp.com>`. */
export const fromAddress = (s) => (s.from_name ? `"${s.from_name.replace(/"/g, '')}" <${s.from_email}>` : s.from_email);

export function settingsTransport(s, password) {
  const port = Number(s.port);
  return nodemailer.createTransport({
    host: s.host,
    port,
    // 465 is TLS from the first byte; anything else must upgrade with STARTTLS,
    // so the password never crosses the wire in the clear.
    secure: port === 465,
    requireTLS: port !== 465,
    auth: { user: s.username, pass: password },
    ...TIMEOUTS,
  });
}

/** A mailer (as `createMailer` returns) for one workspace's saved settings. */
export function workspaceMailer(row, serviceToken) {
  const password = openPassword(row.password_sealed, serviceToken);
  if (!password) return null;
  const transport = settingsTransport(row, password);
  const from = fromAddress(row);
  return {
    label: `${row.host}:${row.port} (workspace)`,
    from,
    async send(message) {
      const info = await transport.sendMail({ from, ...(row.reply_to ? { replyTo: row.reply_to } : {}), ...message });
      return { messageId: info.messageId ?? null, response: info.response ?? '' };
    },
  };
}

/** What went wrong talking to the mail server, in words someone can act on. */
export function explainSmtpError(error, host) {
  const gmail = /gmail\.com$|googlemail\.com$/i.test(host ?? '');
  if (error.code === 'EAUTH' || error.responseCode === 535 || error.responseCode === 534) {
    return gmail
      ? 'Google refused the email address or password. Gmail needs an App Password here, not your normal password: turn on 2-Step Verification, then create one at myaccount.google.com/apppasswords and paste its 16 letters.'
      : 'The mail server refused the username or password.';
  }
  if (['ETIMEDOUT', 'ECONNECTION', 'ESOCKET', 'ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH'].includes(error.code)) {
    return `Could not reach ${host}. Check the server name and port (465 for SSL, 587 for STARTTLS). `
      + 'Some hosts block outgoing mail ports: Railway allows SMTP only on its Pro plan, so on a Free, Trial or Hobby plan no SMTP server can be reached.';
  }
  return String(error.response ?? error.message ?? error).slice(0, 300);
}
