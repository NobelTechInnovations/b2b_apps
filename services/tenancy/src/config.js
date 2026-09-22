import { defineConfig, env } from '@nexus/service-kit';

export const config = defineConfig({
  nodeEnv: env('string', { default: 'development' }),
  port: env('number', { default: 4002 }),
  databaseUrl: env('string', { required: true, secret: true }),
  natsUrl: env('string', { default: 'nats://localhost:4222' }),
  tokenIssuer: env('string', { default: 'http://localhost:4001' }),
  jwksUrl: env('string', { default: 'http://localhost:4001/.well-known/jwks.json' }),
  cookieSecret: env('string', { required: true, secret: true }),
  serviceToken: env('string', { required: true, secret: true }),
  identityUrl: env('string', { default: 'http://localhost:4001' }),
  appUrl: env('string', { default: 'http://localhost:3000' }),
  webOrigin: env('list', { default: ['http://localhost:3000'] }),
});
