import { id } from '@nexus/db-kit';
import { newRefreshToken, hashToken } from './tokens-helpers.js';

export async function createSession(db, { userId, orgId, request, config }) {
  const refresh = newRefreshToken();
  const sessionId = id('ses');
  const familyId = id('fam');

  const session = await db.one(
    `INSERT INTO sessions
       (id, user_id, family_id, refresh_hash, user_agent, ip, device_label, active_org_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + ($9 || ' seconds')::interval)
     RETURNING *`,
    [
      sessionId,
      userId,
      familyId,
      refresh.hash,
      request.headers['user-agent']?.slice(0, 500) ?? null,
      request.ip,
      describeDevice(request.headers['user-agent']),
      orgId ?? null,
      String(config.refreshTokenTtl),
    ],
  );

  return { session, refreshToken: refresh.raw };
}

/**
 * Rotate a refresh token.
 *
 * Three outcomes:
 *   valid current token  → new token issued, old one remembered
 *   already-rotated token→ REUSE DETECTED: kill the whole family
 *   unknown token        → rejected
 */
export async function rotateSession(db, { presented, config, request }) {
  const presentedHash = hashToken(presented);

  return db.transaction(async (tx) => {
    const current = await tx.one(
      `SELECT * FROM sessions WHERE refresh_hash = $1 FOR UPDATE`,
      [presentedHash],
    );

    if (!current) {
      const reused = await tx.one(`SELECT * FROM sessions WHERE previous_hash = $1`, [presentedHash]);
      if (reused) {
        await tx.query(
          `UPDATE sessions SET revoked_at = now(), revoked_reason = 'token_reuse_detected'
           WHERE family_id = $1 AND revoked_at IS NULL`,
          [reused.family_id],
        );
        return { outcome: 'reuse_detected', familyId: reused.family_id, userId: reused.user_id };
      }
      return { outcome: 'unknown' };
    }

    if (current.revoked_at) return { outcome: 'revoked' };
    if (new Date(current.expires_at) < new Date()) return { outcome: 'expired' };

    const next = newRefreshToken();
    const updated = await tx.one(
      `UPDATE sessions
          SET refresh_hash = $1,
              previous_hash = $2,
              last_used_at = now(),
              ip = $3,
              expires_at = now() + ($4 || ' seconds')::interval
        WHERE id = $5
      RETURNING *`,
      [next.hash, presentedHash, request.ip, String(config.refreshTokenTtl), current.id],
    );

    return { outcome: 'rotated', session: updated, refreshToken: next.raw };
  });
}

export async function revokeSession(db, sessionId, reason = 'signed_out') {
  return db.one(
    `UPDATE sessions SET revoked_at = now(), revoked_reason = $2
      WHERE id = $1 AND revoked_at IS NULL RETURNING id, user_id`,
    [sessionId, reason],
  );
}

export async function revokeAllSessions(db, userId, { except, reason = 'revoked_all' } = {}) {
  const { rowCount } = await db.query(
    `UPDATE sessions SET revoked_at = now(), revoked_reason = $3
      WHERE user_id = $1 AND revoked_at IS NULL AND ($2::text IS NULL OR id <> $2)`,
    [userId, except ?? null, reason],
  );
  return rowCount;
}

export async function listSessions(db, userId) {
  return db.rows(
    `SELECT id, device_label, user_agent, ip::text, active_org_id,
            last_used_at, created_at, expires_at
       FROM sessions
      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
      ORDER BY last_used_at DESC`,
    [userId],
  );
}

export async function setActiveOrg(db, sessionId, orgId) {
  await db.query(`UPDATE sessions SET active_org_id = $2 WHERE id = $1`, [sessionId, orgId]);
}

function describeDevice(ua = '') {
  const browser =
    /Edg\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : /Firefox\//.test(ua) ? 'Firefox'
    : 'Browser';

  const os =
    /Windows/.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
    : /Android/.test(ua) ? 'Android'
    : /iPhone|iPad|iOS/.test(ua) ? 'iOS'
    : /Linux/.test(ua) ? 'Linux'
    : 'Unknown OS';

  return `${browser} on ${os}`;
}
