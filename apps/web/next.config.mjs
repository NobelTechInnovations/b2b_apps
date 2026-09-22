/** @type {import('next').NextConfig} */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

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
  env: {
    NEXT_PUBLIC_API_URL: process.env.API_URL ?? 'http://localhost:4000',
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
