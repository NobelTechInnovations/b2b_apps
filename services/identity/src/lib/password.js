import { hash, verify } from '@node-rs/argon2';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

// OWASP-recommended argon2id parameters (19 MiB, t=2, p=1).
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

export const hashPassword = (plain) => hash(plain, OPTIONS);

export async function verifyPassword(plain, stored) {
  if (!stored) {
    // Constant-ish work even when the account has no password, so response
    // timing does not reveal whether an email exists.
    await hash('dummy-password-for-timing-equalisation', OPTIONS).catch(() => {});
    return false;
  }
  try {
    return await verify(stored, plain);
  } catch {
    return false;
  }
}

/** Opaque high-entropy token; only its SHA-256 is ever stored. */
export function generateToken(bytes = 32) {
  const raw = randomBytes(bytes).toString('base64url');
  return { raw, hash: hashToken(raw) };
}

export const hashToken = (raw) => createHash('sha256').update(raw).digest('hex');

export function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Password policy. Deliberately length-first rather than symbol-soup:
 * long passphrases beat short complex ones.
 */
const COMMON = new Set([
  'password', 'password1', '12345678', 'qwerty123', 'welcome1',
  'admin123', 'letmein1', 'iloveyou', 'changeme', 'password123',
]);

export function checkPasswordStrength(password, { email, name } = {}) {
  const problems = [];
  if (password.length < 10) problems.push('Use at least 10 characters.');
  if (password.length > 200) problems.push('That is longer than 200 characters.');
  if (!/[a-zA-Z]/.test(password)) problems.push('Include at least one letter.');
  if (!/[0-9\W]/.test(password)) problems.push('Include at least one number or symbol.');
  if (COMMON.has(password.toLowerCase())) problems.push('That password is too common.');

  const local = email?.split('@')[0]?.toLowerCase();
  if (local && local.length > 3 && password.toLowerCase().includes(local)) {
    problems.push('Do not include your email address.');
  }
  if (name && name.length > 3 && password.toLowerCase().includes(name.toLowerCase())) {
    problems.push('Do not include your name.');
  }

  return { ok: problems.length === 0, problems };
}
