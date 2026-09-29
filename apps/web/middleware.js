import { NextResponse } from 'next/server';
import { tenantFromHost } from '@/lib/tenant';

/**
 * Every request learns which company subdomain it arrived on, so server
 * components can put the signed-in user in the right workspace (or refuse).
 * The header is always overwritten here, so a client cannot supply its own.
 */
export function middleware(request) {
  const host = request.headers.get('host');
  const tenant = tenantFromHost(host);
  const { pathname, search } = request.nextUrl;

  // A company's own address opens its workspace, not the marketing site.
  if (tenant && (pathname === '/' || pathname === '/pricing' || pathname === '/apps-directory')) {
    return NextResponse.redirect(new URL('/dashboard', request.url));
  }

  const headers = new Headers(request.headers);
  headers.set('x-nexus-page', pathname + search);
  if (tenant) headers.set('x-nexus-tenant', tenant);
  else headers.delete('x-nexus-tenant');
  return NextResponse.next({ request: { headers } });
}

export const config = { matcher: ['/((?!_next|favicon.ico|api/).*)'] };
