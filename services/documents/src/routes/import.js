import { id } from '@nexus/db-kit';
import {
  requirePermission, body, params, validate as v, notFound, badRequest, forbidden,
} from '@nexus/service-kit';
import { importTarget, importTargetsFor, suggestMapping } from '@nexus/contracts';
import { readRows } from '../lib/spreadsheet.js';
import { validateRows } from '../lib/import-engine.js';

const BATCH_SIZE = 200;

export async function importRoutes(app) {
  const { db, storage, targets } = app;

  async function loadDocument(orgId, documentId) {
    const document = await db.one(
      `SELECT * FROM documents WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`,
      [documentId, orgId],
    );
    if (!document) throw notFound('Document');
    if (document.kind !== 'spreadsheet') {
      throw badRequest('Only spreadsheets can be imported.');
    }
    return document;
  }

  async function loadBuffer(orgId, checksum) {
    const blob = await db.one(
      `SELECT storage_key FROM blobs WHERE checksum = $1 AND org_id = $2`,
      [checksum, orgId],
    );
    if (!blob) throw notFound('File content');
    return storage.get(blob.storage_key);
  }

  // ═══════════════════════════════════════════════════════ WHAT CAN I IMPORT?
  app.get(
    '/documents/import/targets',
    { preHandler: [app.loadContext, requirePermission('documents.files.view')] },
    async (request) => {
      // Only apps this workspace actually has, and only where the person
      // holds the permission to create those records.
      const entitled = [...request.ctx.apps];
      const available = importTargetsFor(entitled).filter((t) => request.ctx.can(t.permission));

      return {
        data: available.map((t) => ({
          key: t.key, app: t.app, label: t.label, description: t.description,
          icon: t.icon, dedupe_on: t.dedupeOn,
          fields: t.fields.map((f) => ({
            key: f.key, label: f.label, type: f.type,
            required: f.required ?? false, options: f.options,
          })),
        })),
        meta: {
          blocked: importTargetsFor(entitled)
            .filter((t) => !request.ctx.can(t.permission))
            .map((t) => ({ key: t.key, label: t.label, needs: t.permission })),
        },
      };
    },
  );

  // ══════════════════════════════════════════════════ ANALYSE + SUGGEST A MAP
  app.post(
    '/documents/:documentId/import/analyse',
    {
      preHandler: [app.loadContext, requirePermission('documents.files.view')],
      schema: {
        params: params({ documentId: v.id('doc') }),
        body: body({ sheet_name: v.text(120), target_key: v.text(60) }, ['target_key']),
      },
    },
    async (request) => {
      const { orgId } = request.ctx;
      const target = importTarget(request.body.target_key);
      if (!target) throw badRequest('Unknown import target.');
      if (!request.ctx.hasApp(target.app)) {
        throw forbidden(`Add the ${target.app} app before importing into it.`, { code: 'app_not_entitled' });
      }
      request.ctx.assert(target.permission);

      const document = await loadDocument(orgId, request.params.documentId);
      const profile = Array.isArray(document.sheet_profile) ? document.sheet_profile : [];
      const sheet = request.body.sheet_name
        ? profile.find((s) => s.name === request.body.sheet_name)
        : profile[0];

      if (!sheet) throw badRequest('That sheet is not in this workbook.');

      const mapping = suggestMapping(sheet.headers, target.key);
      const mappedFields = new Set(Object.values(mapping));

      return {
        data: {
          sheet: {
            name: sheet.name,
            total_rows: sheet.total_rows,
            header_row: sheet.header_row,
            columns: sheet.columns,
            preview: sheet.preview.slice(0, 15),
          },
          target: {
            key: target.key, label: target.label, dedupe_on: target.dedupeOn,
            fields: target.fields.map((f) => ({
              key: f.key, label: f.label, type: f.type,
              required: f.required ?? false, options: f.options,
              suggested: mappedFields.has(f.key),
            })),
          },
          suggested_mapping: mapping,
          unmapped_columns: sheet.headers.filter((h) => !mapping[h]),
          missing_required: target.fields
            .filter((f) => f.required && !mappedFields.has(f.key))
            .map((f) => ({ key: f.key, label: f.label })),
        },
      };
    },
  );

  // ══════════════════════════════════════════════════════════════════ DRY RUN
  /**
   * Validates every row and reports exactly what would happen, without
   * writing anything. This is the whole point of the wizard: nobody should
   * discover a bad import by finding broken records afterwards.
   */
  app.post(
    '/documents/:documentId/import/validate',
    {
      preHandler: [app.loadContext, requirePermission('documents.files.view')],
      schema: {
        params: params({ documentId: v.id('doc') }),
        body: body(
          {
            sheet_name: v.text(120),
            target_key: v.text(60),
            mapping: { type: 'object', additionalProperties: { type: ['string', 'null'] } },
          },
          ['target_key', 'mapping'],
        ),
      },
    },
    async (request) => {
      const { orgId, userId } = request.ctx;
      const target = importTarget(request.body.target_key);
      if (!target) throw badRequest('Unknown import target.');
      request.ctx.assert(target.permission);

      const document = await loadDocument(orgId, request.params.documentId);
      const profile = Array.isArray(document.sheet_profile) ? document.sheet_profile : [];
      const sheetName = request.body.sheet_name ?? profile[0]?.name;
      const sheet = profile.find((s) => s.name === sheetName);
      if (!sheet) throw badRequest('That sheet is not in this workbook.');

      const buffer = await loadBuffer(orgId, document.checksum);
      const { rows } = await readRows(buffer, {
        extension: document.extension,
        sheetName,
        headerRow: sheet.header_row,
      });

      // Ask the target which dedupe keys it already has, so the preview can
      // say "will update" rather than guessing "will create".
      let existingKeys = new Set();
      if (target.dedupeOn) {
        const column = Object.entries(request.body.mapping)
          .find(([, field]) => field === target.dedupeOn)?.[0];
        if (column) {
          const values = [...new Set(
            rows.map((r) => r[column]).filter((x) => x !== null && String(x).trim() !== '')
              .map((x) => String(x).trim().toLowerCase()),
          )].slice(0, 5000);
          existingKeys = await targets.existingKeys(target, { orgId, values });
        }
      }

      const result = validateRows({
        rows,
        mapping: request.body.mapping,
        targetKey: target.key,
        existingKeys,
      });

      // Persist as a draft job so execute() runs exactly what was previewed.
      const job = await db.transaction(async (tx) => {
        const created = await tx.one(
          `INSERT INTO import_jobs
             (id, org_id, document_id, sheet_name, target_key, mapping, status,
              total_rows, valid_rows, warning_rows, error_rows, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,'validated',$7,$8,$9,$10,$11) RETURNING *`,
          [
            id('imj'), orgId, document.id, sheetName, target.key,
            JSON.stringify(request.body.mapping),
            result.summary.total, result.summary.ok, result.summary.warnings,
            result.summary.errors, userId,
          ],
        );

        // Store rows in chunks — a 5000-row sheet is 5000 inserts otherwise.
        for (let i = 0; i < result.rows.length; i += 500) {
          const chunk = result.rows.slice(i, i + 500);
          const values = [];
          const placeholders = chunk.map((row, index) => {
            const base = index * 7;
            values.push(orgId, created.id, row.row_number, row.severity,
              JSON.stringify(row.issues), JSON.stringify(row.payload), row.outcome);
            return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7})`;
          });
          // The planned outcome is stored, not just the severity, so execution
          // can run exactly what the preview promised.
          await tx.query(
            `INSERT INTO import_rows (org_id, job_id, row_number, severity, issues, payload, outcome)
             VALUES ${placeholders.join(',')}`,
            values,
          );
        }

        return created;
      });

      return {
        data: {
          job_id: job.id,
          ...result,
          // The full row list can be thousands long; send what a person reads.
          rows: result.rows.filter((r) => r.severity !== 'ok').slice(0, 50),
          sample: result.rows.slice(0, 10),
        },
      };
    },
  );

  // ══════════════════════════════════════════════════════════════════ EXECUTE
  app.post(
    '/documents/import/:jobId/execute',
    {
      preHandler: [app.loadContext, requirePermission('documents.files.view')],
      schema: {
        params: params({ jobId: v.id('imj') }),
        body: body({ skip_errors: { type: 'boolean', default: true } }),
      },
    },
    async (request) => {
      const { orgId, userId } = request.ctx;

      const job = await db.one(
        `SELECT * FROM import_jobs WHERE id = $1 AND org_id = $2`,
        [request.params.jobId, orgId],
      );
      if (!job) throw notFound('Import job');
      if (job.status === 'completed') throw badRequest('This import has already run.');
      if (job.status === 'running') throw badRequest('This import is already running.');
      if (job.status !== 'validated') throw badRequest('Validate the import before running it.');

      const target = importTarget(job.target_key);
      if (!target) throw badRequest('Unknown import target.');
      request.ctx.assert(target.permission);

      if (job.error_rows > 0 && request.body?.skip_errors === false) {
        throw badRequest(
          `${job.error_rows} row(s) have errors. Fix them, or allow the import to skip them.`,
        );
      }

      await db.query(
        `UPDATE import_jobs SET status = 'running', started_at = now() WHERE id = $1 AND org_id = $2`,
        [job.id, orgId],
      );

      // Rows the preview marked as skipped are NOT sent. Telling someone a
      // duplicate will be skipped and then letting it overwrite the original
      // is the worst thing an import wizard can do.
      const rows = await db.rows(
        `SELECT row_number, payload FROM import_rows
          WHERE org_id = $1 AND job_id = $2
            AND severity <> 'error' AND outcome <> 'skipped'
          ORDER BY row_number`,
        [orgId, job.id],
      );

      const plannedSkips = await db.one(
        `SELECT count(*)::int AS n FROM import_rows
          WHERE org_id = $1 AND job_id = $2 AND outcome = 'skipped'`,
        [orgId, job.id],
      );

      const totals = { created: 0, updated: 0, skipped: plannedSkips.n, failed: 0 };

      try {
        for (let i = 0; i < rows.length; i += BATCH_SIZE) {
          const batch = rows.slice(i, i + BATCH_SIZE);

          const response = await targets.importBatch(target, {
            orgId,
            userId,
            jobId: job.id,
            rows: batch.map((r) => ({ row_number: r.row_number, data: r.payload })),
          });

          for (const result of response?.results ?? []) {
            totals[result.outcome] = (totals[result.outcome] ?? 0) + 1;
            await db.query(
              `UPDATE import_rows SET outcome = $3, target_id = $4,
                      issues = CASE WHEN $5::text IS NULL THEN issues
                                    ELSE issues || jsonb_build_array(
                                      jsonb_build_object('severity','error','message',$5::text)) END
                WHERE org_id = $1 AND job_id = $2 AND row_number = $6`,
              [orgId, job.id, result.outcome, result.id ?? null, result.error ?? null, result.row_number],
            );
          }
        }

        const finished = await db.one(
          `UPDATE import_jobs
              SET status = 'completed', finished_at = now(),
                  created_count = $3, updated_count = $4, skipped_count = $5, failed_count = $6
            WHERE id = $1 AND org_id = $2 RETURNING *`,
          [job.id, orgId, totals.created, totals.updated, totals.skipped, totals.failed],
        );

        return {
          data: {
            job_id: finished.id,
            status: finished.status,
            created: totals.created,
            updated: totals.updated,
            skipped: totals.skipped,
            failed: totals.failed,
            errors_skipped: job.error_rows,
            target: target.label,
          },
        };
      } catch (error) {
        await db.query(
          `UPDATE import_jobs SET status = 'failed', finished_at = now(), error_message = $3
            WHERE id = $1 AND org_id = $2`,
          [job.id, orgId, error.message?.slice(0, 500) ?? 'unknown error'],
        );
        request.log.error({ err: error, jobId: job.id }, 'import failed');
        throw badRequest(`The import could not be completed: ${error.message}`);
      }
    },
  );

  // ══════════════════════════════════════════════════════════════════ RESULTS
  app.get(
    '/documents/import/:jobId',
    {
      preHandler: [app.loadContext, requirePermission('documents.files.view')],
      schema: { params: params({ jobId: v.id('imj') }) },
    },
    async (request) => {
      const { orgId } = request.ctx;

      const job = await db.one(
        `SELECT j.*, d.name AS document_name FROM import_jobs j
           JOIN documents d ON d.id = j.document_id
          WHERE j.id = $1 AND j.org_id = $2`,
        [request.params.jobId, orgId],
      );
      if (!job) throw notFound('Import job');

      const problems = await db.rows(
        `SELECT row_number, severity, outcome, issues FROM import_rows
          WHERE org_id = $1 AND job_id = $2 AND severity <> 'ok'
          ORDER BY row_number LIMIT 200`,
        [orgId, job.id],
      );

      return { data: { ...job, problems, target: importTarget(job.target_key)?.label ?? job.target_key } };
    },
  );

  app.get(
    '/documents/imports',
    { preHandler: [app.loadContext, requirePermission('documents.files.view')] },
    async (request) => {
      const rows = await db.rows(
        `SELECT j.id, j.target_key, j.sheet_name, j.status, j.total_rows,
                j.created_count, j.updated_count, j.skipped_count, j.failed_count,
                j.created_at, d.name AS document_name
           FROM import_jobs j JOIN documents d ON d.id = j.document_id
          WHERE j.org_id = $1
          ORDER BY j.created_at DESC LIMIT 25`,
        [request.ctx.orgId],
      );
      return {
        data: rows.map((r) => ({ ...r, target: importTarget(r.target_key)?.label ?? r.target_key })),
      };
    },
  );
}
