import { defineConfig, env } from '@nexus/service-kit';
export const config = defineConfig({
  nodeEnv: env('string', { default: 'development' }),
  port: env('number', { default: 4009 }),
  databaseUrl: env('string', { required: true, secret: true }),
  cookieSecret: env('string', { required: true, secret: true }),
  serviceToken: env('string', { required: true, secret: true }),
  tokenIssuer: env('string', { default: 'http://localhost:4001' }),
  jwksUrl: env('string', { default: 'http://localhost:4001/.well-known/jwks.json' }),
  identityUrl: env('string', { default: 'http://localhost:4001' }),
  gatewayUrl: env('string', { default: 'http://localhost:4000' }),
  tenancyUrl: env('string', { default: 'http://localhost:4002' }),
  aiApiKey: env('string', { secret: true }),
  aiBaseUrl: env('string', { default: 'https://integrate.api.nvidia.com/v1' }),
  aiModel: env('string', { default: 'nvidia/nemotron-3-ultra-550b-a55b' }),
  mcpAllowedHosts: env('list', { default: ['localhost', '127.0.0.1', '[::1]'] }),
  mcpAllowedOrigins: env('list', { default: ['http://localhost:3100', 'http://localhost:3000'] }),
});
