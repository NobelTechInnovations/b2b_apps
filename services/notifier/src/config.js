import { defineConfig, env } from '@nexus/service-kit';

export const config = defineConfig({
  nodeEnv: env('string', { default: 'development' }),
  port: env('number', { default: 4006 }),
  databaseUrl: env('string', { required: true, secret: true }),
  natsUrl: env('string', { default: 'nats://localhost:4222' }),
  tokenIssuer: env('string', { default: 'http://localhost:4001' }),
  jwksUrl: env('string', { default: 'http://localhost:4001/.well-known/jwks.json' }),
  cookieSecret: env('string', { required: true, secret: true }),
  serviceToken: env('string', { required: true, secret: true }),
  // Who holds a permission is tenancy's to answer.
  tenancyUrl: env('string', { default: 'http://localhost:4002' }),
  // Email addresses for notifications that are also emailed, and the web app
  // their buttons open.
  identityUrl: env('string', { default: 'http://localhost:4001' }),
  appUrl: env('string', { default: 'http://localhost:3000' }),
  // Either one URL — smtps://user:password@smtp.example.com:465 — or the
  // separate SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS most providers
  // (ZeptoMail, Brevo, SES) hand out. Neither set means "log, don't send".
  smtpUrl: env('string', { default: '', secret: true }),
  smtpHost: env('string', { default: '' }),
  smtpPort: env('number', { default: 587 }),
  smtpUser: env('string', { default: '' }),
  smtpPass: env('string', { default: '', secret: true }),
  // MAIL_FROM, or EMAIL_FROM as some hosts' templates call it.
  mailFrom: env('string', { default: process.env.EMAIL_FROM || 'Nexus <no-reply@localhost>' }),
  // ZeptoMail over HTTPS instead of SMTP. Needed where outbound SMTP is
  // blocked — Railway's Free, Trial and Hobby plans block it. The token is the
  // Mail Agent's "Send Mail token"; with it set, it is used ahead of SMTP.
  emailProvider: env('string', { default: '' }),
  zeptomailToken: env('string', { default: '', secret: true }),
  // api.zeptomail.in for accounts in India, api.zeptomail.com elsewhere.
  zeptomailApiUrl: env('string', { default: '' }),
});
