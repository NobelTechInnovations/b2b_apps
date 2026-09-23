import { id } from '@nexus/db-kit';
import { requireInternal } from '@nexus/service-kit';
import { EVENTS } from '@nexus/contracts/events';

/**
 * Receives validated rows from the Documents import wizard.
 *
 * Documents does the parsing, coercion and preview; CRM still applies its own
 * rules here — lead scoring, company matching by email domain, dedupe on
 * email — so an imported record is indistinguishable from a hand-entered one.
 */
export async function internalImportRoutes(app) {
  const { db } = app;

  const orgOf = (request) => {
    const orgId = request.headers['x-nexus-org'];
    if (!orgId) throw app.httpErrors.badRequest('missing org context');
    return orgId;
  };
  const actorOf = (request) => request.headers['x-nexus-actor'] || null;

  // ── which of these already exist? ────────────────────────────────────────
  app.post('/internal/import/contacts/existing', { preHandler: requireInternal() }, async (request) => {
    const orgId = orgOf(request);
    const values = (request.body?.values ?? []).map((v) => String(v).toLowerCase());
    if (!values.length) return { data: { keys: [] } };

    const rows = await db.rows(
      `SELECT lower(email) AS key FROM contacts
        WHERE org_id = $1 AND lower(email) = ANY($2) AND archived_at IS NULL`,
      [orgId, values],
    );
    return { data: { keys: rows.map((r) => r.key) } };
  });

  app.post('/internal/import/leads/existing', { preHandler: requireInternal() }, async (request) => {
    const orgId = orgOf(request);
    const values = (request.body?.values ?? []).map((v) => String(v).toLowerCase());
    if (!values.length) return { data: { keys: [] } };

    const rows = await db.rows(
      `SELECT lower(email) AS key FROM leads
        WHERE org_id = $1 AND lower(email) = ANY($2) AND archived_at IS NULL`,
      [orgId, values],
    );
    return { data: { keys: rows.map((r) => r.key) } };
  });

  // ── contacts ─────────────────────────────────────────────────────────────
  app.post('/internal/import/contacts', { preHandler: requireInternal() }, async (request) => {
    const orgId = orgOf(request);
    const userId = actorOf(request);
    const results = [];

    for (const row of request.body?.rows ?? []) {
      const data = row.data ?? {};
      try {
        const result = await db.transaction(async (tx) => {
          // A company named in the sheet is matched or created, so imported
          // contacts are not orphaned from the accounts they belong to.
          let companyId = null;
          if (data.company_name) {
            const domain = data.email?.split('@')[1]?.toLowerCase() ?? null;
            const existing = await tx.one(
              `SELECT id FROM companies
                WHERE org_id = $1 AND archived_at IS NULL
                  AND (lower(name) = lower($2) OR ($3::text IS NOT NULL AND lower(domain) = $3))
                LIMIT 1`,
              [orgId, data.company_name, domain],
            );

            companyId = existing?.id
              ?? (await tx.one(
                `INSERT INTO companies (id, org_id, name, domain, created_by)
                 VALUES ($1,$2,$3,$4,$5) RETURNING id`,
                [id('cmp'), orgId, data.company_name, domain, userId],
              )).id;
          }

          if (data.email) {
            const existing = await tx.one(
              `SELECT id FROM contacts
                WHERE org_id = $1 AND lower(email) = lower($2) AND archived_at IS NULL`,
              [orgId, data.email],
            );

            if (existing) {
              // Update only what the sheet actually carried — an import must
              // never blank a field the spreadsheet simply did not include.
              const updated = await tx.one(
                `UPDATE contacts SET
                   first_name = COALESCE($3, first_name),
                   last_name  = COALESCE($4, last_name),
                   phone      = COALESCE($5, phone),
                   job_title  = COALESCE($6, job_title),
                   department = COALESCE($7, department),
                   linkedin   = COALESCE($8, linkedin),
                   company_id = COALESCE($9, company_id),
                   notes      = COALESCE($10, notes)
                 WHERE id = $1 AND org_id = $2 RETURNING id`,
                [existing.id, orgId, data.first_name ?? null, data.last_name ?? null,
                 data.phone ?? null, data.job_title ?? null, data.department ?? null,
                 data.linkedin ?? null, companyId, data.notes ?? null],
              );
              return { outcome: 'updated', id: updated.id };
            }
          }

          const created = await tx.one(
            `INSERT INTO contacts
               (id, org_id, company_id, first_name, last_name, email, phone,
                job_title, department, linkedin, notes, owner_user_id, created_by, tags)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,ARRAY['imported'])
             RETURNING id`,
            [id('con'), orgId, companyId, data.first_name, data.last_name ?? null,
             data.email ?? null, data.phone ?? null, data.job_title ?? null,
             data.department ?? null, data.linkedin ?? null, data.notes ?? null, userId],
          );
          return { outcome: 'created', id: created.id };
        });

        results.push({ row_number: row.row_number, ...result });
      } catch (error) {
        request.log.warn({ err: error, row: row.row_number }, 'contact import row failed');
        results.push({ row_number: row.row_number, outcome: 'failed', error: error.message?.slice(0, 200) });
      }
    }

    return { data: { results } };
  });

  // ── leads ────────────────────────────────────────────────────────────────
  app.post('/internal/import/leads', { preHandler: requireInternal() }, async (request) => {
    const orgId = orgOf(request);
    const userId = actorOf(request);
    const results = [];

    for (const row of request.body?.rows ?? []) {
      const data = row.data ?? {};
      try {
        if (data.email) {
          const existing = await db.one(
            `SELECT id FROM leads WHERE org_id = $1 AND lower(email) = lower($2) AND archived_at IS NULL`,
            [orgId, data.email],
          );
          if (existing) {
            results.push({ row_number: row.row_number, outcome: 'skipped', id: existing.id });
            continue;
          }
        }

        // Scored on import exactly as a hand-entered lead would be.
        let score = 10;
        if (data.email) score += 25;
        if (data.phone) score += 20;
        if (data.company_name) score += 15;
        if (data.job_title) score += 10;
        if (data.estimated_value) score += 10;
        if (data.rating === 'hot') score += 20;
        else if (data.rating === 'warm') score += 10;

        const created = await db.one(
          `INSERT INTO leads
             (id, org_id, first_name, last_name, company_name, email, phone, job_title,
              source, rating, score, estimated_value, owner_user_id, created_by, tags, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,'import'),$10,$11,$12::numeric,$13,$13,
                   ARRAY['imported'],$14)
           RETURNING id`,
          [id('led'), orgId, data.first_name, data.last_name ?? null, data.company_name ?? null,
           data.email ?? null, data.phone ?? null, data.job_title ?? null, data.source ?? null,
           data.rating ?? null, Math.min(score, 100), data.estimated_value ?? null, userId,
           data.notes ?? null],
        );

        results.push({ row_number: row.row_number, outcome: 'created', id: created.id });
      } catch (error) {
        request.log.warn({ err: error, row: row.row_number }, 'lead import row failed');
        results.push({ row_number: row.row_number, outcome: 'failed', error: error.message?.slice(0, 200) });
      }
    }

    return { data: { results } };
  });
}
