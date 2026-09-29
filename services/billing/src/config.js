import { defineConfig, env } from '@nexus/service-kit';

export const config = defineConfig({
  nodeEnv: env('string', { default: 'development' }),
  port: env('number', { default: 4004 }),
  databaseUrl: env('string', { required: true, secret: true }),
  natsUrl: env('string', { default: 'nats://localhost:4222' }),
  tokenIssuer: env('string', { default: 'http://localhost:4001' }),
  jwksUrl: env('string', { default: 'http://localhost:4001/.well-known/jwks.json' }),
  cookieSecret: env('string', { required: true, secret: true }),
  serviceToken: env('string', { required: true, secret: true }),
  catalogUrl: env('string', { default: 'http://localhost:4003' }),
  tenancyUrl: env('string', { default: 'http://localhost:4002' }),

  // Razorpay. Without keys, online payment is off (and, with BILLING_TEST_MODE,
  // invoices can be settled by a local "test payment" instead).
  razorpayKeyId: env('string', { default: '' }),
  razorpayKeySecret: env('string', { default: '', secret: true }),
  razorpayWebhookSecret: env('string', { default: '', secret: true }),
  billingTestMode: env('boolean', { default: false }),
  billingCompanyName: env('string', { default: 'Nexus' }),
});
