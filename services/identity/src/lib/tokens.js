import { SignJWT } from 'jose';
import { id } from '@nexus/db-kit';
import { generateToken } from './password.js';

/**
 * Access token — short-lived, RS256, verified locally by every service.
 *
 * Deliberately NOT in the token: permissions. They change often, would bloat
 * every request, and would stay stale for the token's lifetime. The gateway
 * resolves them per request from a cache keyed on the membership epoch.
 */
export async function signAccessToken({ keys, config, user, membership, sessionId }) {
  const now = Math.floor(Date.now() / 1000);

  const claims = {
    sub: user.id,
    email: user.email,
    name: user.name,
    sid: sessionId,
    org: membership?.org_id ?? null,
    mem: membership?.id ?? null,
    roles: membership?.roles ?? [],
    ver: membership?.epoch ?? 0,
  };

  return new SignJWT(claims)
    .setProtectedHeader({ alg: keys.alg, kid: keys.kid, typ: 'JWT' })
    .setIssuedAt(now)
    .setIssuer(config.tokenIssuer)
    .setAudience('nexus')
    .setExpirationTime(now + config.accessTokenTtl)
    .setJti(id('jti'))
    .sign(keys.privateKey);
}

/**
 * Refresh token — opaque, rotated on every use, stored only as a hash.
 *
 * Reuse detection: each session keeps the previous token's hash. Presenting an
 * already-rotated token means it leaked, so the entire family is revoked and
 * every device signed out. This is the standard defence against token theft.
 */
export function newRefreshToken() {
  return generateToken(48);
}

export function cookieOptions(config, { maxAge, path = '/' } = {}) {
  return {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    domain: config.cookieDomain,
    path,
    maxAge,
  };
}

export function setAuthCookies(reply, config, { accessToken, refreshToken }) {
  reply.setCookie('nx_at', accessToken, cookieOptions(config, { maxAge: config.accessTokenTtl }));
  if (refreshToken) {
    reply.setCookie(
      'nx_rt',
      refreshToken,
      cookieOptions(config, {
        maxAge: config.refreshTokenTtl,
        path: config.refreshCookiePath,
      }),
    );
  }
}

export function clearAuthCookies(reply, config) {
  reply.clearCookie('nx_at', cookieOptions(config));
  reply.clearCookie('nx_rt', cookieOptions(config, { path: config.refreshCookiePath }));
}
