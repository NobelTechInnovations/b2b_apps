import { defineConfig, env } from '@nexus/service-kit';

export const config = defineConfig({
  nodeEnv: env('string', { default: 'development' }),
  port: env('number', { default: 4001 }),

  databaseUrl: env('string', { required: true, secret: true }),
  natsUrl: env('string', { default: 'nats://localhost:4222' }),

  tokenIssuer: env('string', { default: 'http://localhost:4001' }),
  jwksUrl: env('string', { default: 'http://localhost:4001/.well-known/jwks.json' }),
  accessTokenTtl: env('number', { default: 600 }),          // 10 minutes
  refreshTokenTtl: env('number', { default: 60 * 60 * 24 * 30 }), // 30 days

  cookieSecret: env('string', { required: true, secret: true }),
  cookieDomain: env('string', { default: undefined }),
  cookieSecure: env('boolean', { default: false }),
  // Narrow path so the refresh token is not sent on every API call. It must
  // match the PUBLIC path, which is the gateway's — not identity's own.
  refreshCookiePath: env('string', { default: '/api/auth' }),

  serviceToken: env('string', { required: true, secret: true }),
  tenancyUrl: env('string', { default: 'http://localhost:4002' }),

  webOrigin: env('list', { default: ['http://localhost:3000'] }),
  appUrl: env('string', { default: 'http://localhost:3000' }),

  maxFailedAttempts: env('number', { default: 8 }),
  // Tight in production, loose locally so test runs are repeatable.
  registerPerHour: env('number', { default: 10 }),
  lockoutMinutes: env('number', { default: 15 }),
});
