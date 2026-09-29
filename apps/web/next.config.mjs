/** @type {import('next').NextConfig} */
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// One configuration for the whole repository: locally the web app reads the
// same root .env as the services (without overriding anything already set).
// On Vercel there is no file and the project's environment variables apply.
const rootEnv = path.join(here, '..', '..', '.env');
if (existsSync(rootEnv)) {
  for (const line of readFileSync(rootEnv, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const nextConfig = {
  reactStrictMode: true,
  // `next build` and `next dev` must never share an output directory: a build
  // run while the dev server is live overwrites its manifests and every route
  // starts returning 500 until `.next` is deleted.
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  // The repo holds many packages; pin the trace root so Next does not guess.
  outputFileTracingRoot: path.join(here, '..', '..'),
  transpilePackages: ['@nexus/contracts'],
  poweredByHeader: false,
  // Local company subdomains (http://<slug>.lvh.me:3100) load dev assets from
  // an origin other than localhost; Next blocks those unless listed. Dev only.
  allowedDevOrigins: ['lvh.me', '*.lvh.me', ...(process.env.NEXT_PUBLIC_ROOT_DOMAIN ? [process.env.NEXT_PUBLIC_ROOT_DOMAIN.split(':')[0], `*.${process.env.NEXT_PUBLIC_ROOT_DOMAIN.split(':')[0]}`] : [])],
  // The browser calls /api on whatever host it is on — the apex or a company
  // subdomain — and Next forwards it to the gateway. Cookies stay first-party.
  async rewrites() {
    const gateway = (process.env.API_URL ?? 'http://localhost:4000').replace(/\/$/, '');
    return [{ source: '/api/:path*', destination: `${gateway}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default nextConfig;
