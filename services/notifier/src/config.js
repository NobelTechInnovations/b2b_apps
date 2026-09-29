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
  // smtps://user:password@smtp.example.com:465 — unset means "log, don't send".
  smtpUrl: env('string', { default: '', secret: true }),
  mailFrom: env('string', { default: 'Nexus <no-reply@localhost>' }),
});
