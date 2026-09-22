import { randomBytes } from 'node:crypto';

// Sortable, prefixed, URL-safe identifiers: usr_01j9x8k2m4q7rt3vwz5abc
// 48 bits of timestamp + 64 bits of randomness, Crockford base32.
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

function encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function id(prefix) {
  if (!prefix || !/^[a-z]{2,6}$/.test(prefix)) {
    throw new Error(`invalid id prefix: ${prefix}`);
  }
  const now = Date.now();
  const time = Buffer.alloc(6);
  time.writeUIntBE(now, 0, 6);
  return `${prefix}_${encode(Buffer.concat([time, randomBytes(10)]))}`;
}

export function isId(value, prefix) {
  if (typeof value !== 'string') return false;
  const pattern = prefix ? `^${prefix}_[0-9a-hjkmnp-tv-z]{26}$` : '^[a-z]{2,6}_[0-9a-hjkmnp-tv-z]{26}$';
  return new RegExp(pattern).test(value);
}
