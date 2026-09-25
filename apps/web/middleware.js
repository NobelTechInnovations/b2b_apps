import { NextResponse } from 'next/server';

export function middleware(request) {
  const headers = new Headers(request.headers);
  headers.set('x-nexus-page', request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.next({ request: { headers } });
}

export const config = { matcher: ['/((?!_next|favicon.ico).*)'] };
