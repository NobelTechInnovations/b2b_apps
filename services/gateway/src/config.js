import { defineConfig, env } from '@nexus/service-kit';

export const config = defineConfig({
  nodeEnv: env('string', { default: 'development' }),
  port: env('number', { default: 4000 }),
  natsUrl: env('string', { default: 'nats://localhost:4222' }),
  tokenIssuer: env('string', { default: 'http://localhost:4001' }),
  jwksUrl: env('string', { default: 'http://localhost:4001/.well-known/jwks.json' }),
  cookieSecret: env('string', { required: true, secret: true }),
  serviceToken: env('string', { required: true, secret: true }),
  tenancyUrl: env('string', { default: 'http://localhost:4002' }),
  catalogUrl: env('string', { default: 'http://localhost:4003' }),
  billingUrl: env('string', { default: 'http://localhost:4004' }),
  webOrigin: env('list', { default: ['http://localhost:3000'] }),
  rateLimitMax: env('number', { default: 600 }),
});
