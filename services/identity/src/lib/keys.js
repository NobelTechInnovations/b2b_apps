import { generateKeyPair, exportJWK, exportPKCS8, importPKCS8, calculateJwkThumbprint } from 'jose';
import { id } from '@nexus/db-kit';

const ALG = 'RS256';

/**
 * Signing keys live in the database so every replica of identity signs with
 * the same key and the published JWKS survives restarts. Rotation is additive:
 * a new key becomes active, the previous one moves to `retiring` and keeps
 * being published until every token it signed has expired.
 */
export async function loadKeys(db, logger) {
  let rows = await db.rows(
    `SELECT id, kid, algorithm, public_jwk, private_pem, status
     FROM signing_keys WHERE status IN ('active', 'retiring')
     ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at DESC`,
  );

  if (!rows.some((r) => r.status === 'active')) {
    logger.info('no active signing key — generating one');
    await createKey(db);
    rows = await db.rows(
      `SELECT id, kid, algorithm, public_jwk, private_pem, status
       FROM signing_keys WHERE status IN ('active', 'retiring')
       ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at DESC`,
    );
  }

  const active = rows.find((r) => r.status === 'active');
  const privateKey = await importPKCS8(active.private_pem, ALG);

  return {
    kid: active.kid,
    alg: ALG,
    privateKey,
    /** Everything a verifier might legitimately need, active key first. */
    jwks: { keys: rows.map((r) => ({ ...r.public_jwk, kid: r.kid, alg: ALG, use: 'sig' })) },
  };
}

export async function createKey(db) {
  const { publicKey, privateKey } = await generateKeyPair(ALG, {
    modulusLength: 2048,
    extractable: true,
  });

  const jwk = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(jwk);
  const pem = await exportPKCS8(privateKey);

  await db.transaction(async (tx) => {
    await tx.query(`UPDATE signing_keys SET status = 'retiring' WHERE status = 'active'`);
    await tx.query(
      `INSERT INTO signing_keys (id, kid, algorithm, public_jwk, private_pem, status)
       VALUES ($1, $2, $3, $4, $5, 'active')`,
      [id('key'), kid, ALG, JSON.stringify({ ...jwk, kid, alg: ALG, use: 'sig' }), pem],
    );
  });

  return kid;
}
