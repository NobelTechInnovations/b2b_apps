import { id, paginate } from '@nexus/db-kit';
import {
  requirePermission, body, query, params, validate as v, notFound, badRequest, forbidden,
} from '@nexus/service-kit';
import { EVENTS } from '@nexus/contracts/events';
import { classify, humanSize } from '../lib/storage.js';
import { profileWorkbook } from '../lib/spreadsheet.js';

export async function fileRoutes(app) {
  const { db, storage, config, quota } = app;

  // ══════════════════════════════════════════════════════════════════ FOLDERS
  app.get(
    '/documents/folders',
    { preHandler: [app.loadContext, requirePermission('documents.files.view')] },
    async (request) => {
      const rows = await db.rows(
        `SELECT f.*,
                (SELECT count(*)::int FROM documents d
                  WHERE d.folder_id = f.id AND d.archived_at IS NULL) AS document_count,
                (SELECT COALESCE(sum(d.byte_size), 0)::bigint FROM documents d
                  WHERE d.folder_id = f.id AND d.archived_at IS NULL) AS byte_size
           FROM folders f
          WHERE f.org_id = $1 AND f.archived_at IS NULL
          ORDER BY f.path, lower(f.name)`,
        [request.ctx.orgId],
      );
      return { data: rows.map((r) => ({ ...r, size_label: humanSize(r.byte_size) })) };
    },
  );

  app.post(
    '/documents/folders',
    {
      preHandler: [app.loadContext, requirePermission('documents.folders.manage')],
      schema: { body: body({ name: v.text(120, 1), parent_id: v.id('fld'), colour: v.text(20) }, ['name']) },
    },
    async (request, reply) => {
      const { orgId, userId } = request.ctx;
      const { name, parent_id: parentId } = request.body;

      let parentPath = '/';
      if (parentId) {
        const parent = await db.one(
          `SELECT path FROM folders WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`,
          [parentId, orgId],
        );
        if (!parent) throw notFound('Parent folder');
        parentPath = parent.path;
      }

      const folderId = id('fld');
      const folder = await db.one(
        `INSERT INTO folders (id, org_id, name, parent_id, path, colour, created_by)
         VALUES ($1,$2,$3,$4,$5,COALESCE($6,'slate'),$7) RETURNING *`,
        [folderId, orgId, name.trim(), parentId ?? null, `${parentPath}${folderId}/`,
         request.body.colour ?? null, userId],
      );

      return reply.status(201).send({ data: { ...folder, document_count: 0, byte_size: 0 } });
    },
  );

  app.delete(
    '/documents/folders/:folderId',
    {
      preHandler: [app.loadContext, requirePermission('documents.folders.manage')],
      schema: { params: params({ folderId: v.id('fld') }) },
    },
    async (request) => {
      const { orgId } = request.ctx;

      const contents = await db.one(
        `SELECT
           (SELECT count(*)::int FROM documents WHERE folder_id = $2 AND org_id = $1 AND archived_at IS NULL) AS docs,
           (SELECT count(*)::int FROM folders WHERE parent_id = $2 AND org_id = $1 AND archived_at IS NULL) AS subfolders`,
        [orgId, request.params.folderId],
      );

      if (contents.docs > 0 || contents.subfolders > 0) {
        throw badRequest(
          `This folder still holds ${contents.docs} file(s) and ${contents.subfolders} subfolder(s). Empty it first.`,
        );
      }

      const row = await db.one(
        `UPDATE folders SET archived_at = now()
          WHERE id = $1 AND org_id = $2 AND archived_at IS NULL AND is_system = false RETURNING id`,
        [request.params.folderId, orgId],
      );
      if (!row) throw notFound('Folder');
      return { data: { archived: true } };
    },
  );

  // ════════════════════════════════════════════════════════════════ DOCUMENTS
  app.get(
    '/documents',
    {
      preHandler: [app.loadContext, requirePermission('documents.files.view')],
      schema: {
        querystring: query({
          folder_id: v.id('fld'),
          kind: v.enum(['file', 'spreadsheet', 'document', 'image', 'pdf', 'archive']),
          root: { type: 'boolean' },
        }),
      },
    },
    async (request) => {
      const { orgId } = request.ctx;
      const page = paginate({ ...request.query, allowedSorts: ['created_at', 'updated_at', 'name', 'byte_size'] });
      const qs = request.query;

      const where = ['d.org_id = $1', 'd.archived_at IS NULL'];
      const values = [orgId];

      if (qs.folder_id) { values.push(qs.folder_id); where.push(`d.folder_id = $${values.length}`); }
      else if (qs.root) where.push('d.folder_id IS NULL');
      if (qs.kind) { values.push(qs.kind); where.push(`d.kind = $${values.length}`); }
      if (qs.q) {
        values.push(`%${qs.q}%`);
        where.push(`(d.name ILIKE $${values.length} OR d.description ILIKE $${values.length})`);
      }

      const clause = where.join(' AND ');

      const [rows, total, usage] = await Promise.all([
        db.rows(
          `SELECT d.*, f.name AS folder_name FROM documents d
             LEFT JOIN folders f ON f.id = d.folder_id
            WHERE ${clause}
            ORDER BY d.${page.orderBy} LIMIT ${page.limit} OFFSET ${page.offset}`,
          values,
        ),
        db.one(`SELECT count(*)::int AS n FROM documents d WHERE ${clause}`, values),
        quota.usage(orgId),
      ]);

      return {
        data: rows.map(shape),
        meta: { ...page.meta(total.n), storage: usage },
      };
    },
  );

  app.get(
    '/documents/:documentId',
    {
      preHandler: [app.loadContext, requirePermission('documents.files.view')],
      schema: { params: params({ documentId: v.id('doc') }) },
    },
    async (request) => {
      const { orgId } = request.ctx;

      const document = await db.one(
        `SELECT d.*, f.name AS folder_name FROM documents d
           LEFT JOIN folders f ON f.id = d.folder_id
          WHERE d.id = $1 AND d.org_id = $2 AND d.archived_at IS NULL`,
        [request.params.documentId, orgId],
      );
      if (!document) throw notFound('Document');

      const [versions, approvals, imports] = await Promise.all([
        db.rows(
          `SELECT * FROM document_versions WHERE org_id = $1 AND document_id = $2
            ORDER BY version DESC`,
          [orgId, document.id],
        ),
        db.rows(
          `SELECT * FROM approvals WHERE org_id = $1 AND document_id = $2
            ORDER BY created_at DESC LIMIT 10`,
          [orgId, document.id],
        ),
        db.rows(
          `SELECT id, target_key, sheet_name, status, total_rows, created_count,
                  updated_count, failed_count, created_at
             FROM import_jobs WHERE org_id = $1 AND document_id = $2
            ORDER BY created_at DESC LIMIT 10`,
          [orgId, document.id],
        ),
      ]);

      return {
        data: {
          ...shape(document),
          versions: versions.map((v) => ({ ...v, size_label: humanSize(v.byte_size) })),
          approvals,
          import_jobs: imports,
        },
      };
    },
  );

  // ══════════════════════════════════════════════════════════════════ UPLOAD
  app.post(
    '/documents/upload',
    { preHandler: [app.loadContext, requirePermission('documents.files.upload')] },
    async (request, reply) => {
      const { orgId, userId } = request.ctx;

      const uploaded = await request.file({ limits: { fileSize: config.maxUploadMb * 1024 * 1024 } });
      if (!uploaded) throw badRequest('No file was uploaded.');

      const buffer = await uploaded.toBuffer();
      if (uploaded.file.truncated) {
        throw badRequest(`Files must be ${config.maxUploadMb} MB or smaller.`);
      }
      if (buffer.byteLength === 0) throw badRequest('That file is empty.');

      const folderId = uploaded.fields?.folder_id?.value || null;
      const replaces = uploaded.fields?.document_id?.value || null;

      // Quota is checked before the write, against the plan's allowance.
      const allowed = await quota.check(orgId, buffer.byteLength);
      if (!allowed.ok) {
        throw forbidden(
          `This upload would take you past your ${humanSize(allowed.limit)} storage allowance. ` +
            `You are using ${humanSize(allowed.used)}.`,
          { code: 'storage_quota_exceeded', used: allowed.used, limit: allowed.limit },
        );
      }

      const { kind, extension } = classify(uploaded.filename, uploaded.mimetype);
      const stored = await storage.put(buffer);

      // Spreadsheets get profiled now, so the import wizard has structure to
      // work with the moment someone opens it.
      let sheetProfile = null;
      if (kind === 'spreadsheet') {
        try {
          sheetProfile = await profileWorkbook(buffer, { extension });
        } catch (error) {
          request.log.warn({ err: error, file: uploaded.filename }, 'could not profile spreadsheet');
        }
      }

      const result = await db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO blobs (checksum, org_id, byte_size, mime_type, storage_key, ref_count)
           VALUES ($1,$2,$3,$4,$5,1)
           ON CONFLICT (checksum) DO UPDATE SET ref_count = blobs.ref_count + 1`,
          [stored.checksum, orgId, stored.byteSize, uploaded.mimetype ?? 'application/octet-stream', stored.key],
        );

        // Uploading onto an existing document makes a new version.
        if (replaces) {
          const existing = await tx.one(
            `SELECT * FROM documents WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`,
            [replaces, orgId],
          );
          if (!existing) throw notFound('Document');

          const version = existing.current_version + 1;

          await tx.query(
            `INSERT INTO document_versions
               (id, org_id, document_id, version, checksum, byte_size, mime_type, uploaded_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [id('dvr'), orgId, existing.id, version, stored.checksum, stored.byteSize,
             uploaded.mimetype ?? null, userId],
          );

          const updated = await tx.one(
            `UPDATE documents
                SET current_version = $3, checksum = $4, byte_size = $5, mime_type = $6,
                    sheet_profile = COALESCE($7::jsonb, sheet_profile)
              WHERE id = $1 AND org_id = $2 RETURNING *`,
            [existing.id, orgId, version, stored.checksum, stored.byteSize,
             uploaded.mimetype ?? null, sheetProfile ? JSON.stringify(sheetProfile) : null],
          );

          return { document: updated, version, isNew: false };
        }

        const documentId = id('doc');
        const created = await tx.one(
          `INSERT INTO documents
             (id, org_id, folder_id, name, kind, checksum, byte_size, mime_type, extension,
              sheet_profile, owner_user_id, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) RETURNING *`,
          [documentId, orgId, folderId, uploaded.filename, kind, stored.checksum,
           stored.byteSize, uploaded.mimetype ?? null, extension,
           sheetProfile ? JSON.stringify(sheetProfile) : null, userId],
        );

        await tx.query(
          `INSERT INTO document_versions
             (id, org_id, document_id, version, checksum, byte_size, mime_type, uploaded_by)
           VALUES ($1,$2,$3,1,$4,$5,$6,$7)`,
          [id('dvr'), orgId, documentId, stored.checksum, stored.byteSize,
           uploaded.mimetype ?? null, userId],
        );

        tx.emit({
          type: EVENTS.FILE_UPLOADED,
          org_id: orgId,
          actor_id: userId,
          data: {
            document_id: documentId,
            name: created.name,
            kind: created.kind,
            byte_size: created.byte_size,
            folder_id: folderId,
          },
        });

        return { document: created, version: 1, isNew: true };
      });

      return reply.status(result.isNew ? 201 : 200).send({
        data: {
          ...shape(result.document),
          version: result.version,
          deduplicated: stored.deduped,
          sheets: sheetProfile?.length ?? 0,
        },
      });
    },
  );

  // ════════════════════════════════════════════════════════════════ DOWNLOAD
  app.get(
    '/documents/:documentId/download',
    {
      preHandler: [app.loadContext, requirePermission('documents.files.view')],
      schema: {
        params: params({ documentId: v.id('doc') }),
        querystring: { type: 'object', properties: { version: { type: 'integer', minimum: 1 } }, additionalProperties: false },
      },
    },
    async (request, reply) => {
      const { orgId } = request.ctx;

      const document = await db.one(
        `SELECT * FROM documents WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`,
        [request.params.documentId, orgId],
      );
      if (!document) throw notFound('Document');

      let checksum = document.checksum;
      if (request.query.version && request.query.version !== document.current_version) {
        const version = await db.one(
          `SELECT checksum FROM document_versions
            WHERE org_id = $1 AND document_id = $2 AND version = $3`,
          [orgId, document.id, request.query.version],
        );
        if (!version) throw notFound('Version');
        checksum = version.checksum;
      }

      const blob = await db.one(
        `SELECT storage_key, mime_type FROM blobs WHERE checksum = $1 AND org_id = $2`,
        [checksum, orgId],
      );
      if (!blob) throw notFound('File content');

      const buffer = await storage.get(blob.storage_key);

      reply.header('content-type', blob.mime_type ?? 'application/octet-stream');
      reply.header('content-disposition', `attachment; filename="${encodeURIComponent(document.name)}"`);
      reply.header('content-length', buffer.byteLength);
      return reply.send(buffer);
    },
  );

  app.patch(
    '/documents/:documentId',
    {
      preHandler: [app.loadContext, requirePermission('documents.files.edit')],
      schema: {
        params: params({ documentId: v.id('doc') }),
        body: body({
          name: v.text(255, 1), description: v.longText, folder_id: v.id('fld'),
          tags: { type: 'array', items: v.text(40), maxItems: 20 },
        }),
      },
    },
    async (request) => {
      const fields = ['name', 'description', 'folder_id', 'tags']
        .filter((f) => request.body[f] !== undefined);
      if (!fields.length) throw badRequest('Nothing to update.');

      const sets = fields.map((f, i) => `${f} = $${i + 3}`).join(', ');
      const updated = await db.one(
        `UPDATE documents SET ${sets}
          WHERE id = $1 AND org_id = $2 AND archived_at IS NULL RETURNING *`,
        [request.params.documentId, request.ctx.orgId, ...fields.map((f) => request.body[f])],
      );
      if (!updated) throw notFound('Document');
      return { data: shape(updated) };
    },
  );

  app.delete(
    '/documents/:documentId',
    {
      preHandler: [app.loadContext, requirePermission('documents.files.delete')],
      schema: { params: params({ documentId: v.id('doc') }) },
    },
    async (request) => {
      const { orgId } = request.ctx;

      const document = await db.transaction(async (tx) => {
        const row = await tx.one(
          `UPDATE documents SET archived_at = now()
            WHERE id = $1 AND org_id = $2 AND archived_at IS NULL RETURNING *`,
          [request.params.documentId, orgId],
        );
        if (!row) return null;

        // Release the blob. The bytes stay until nothing references them,
        // which is what makes deduplication safe.
        await tx.query(
          `UPDATE blobs SET ref_count = GREATEST(ref_count - 1, 0)
            WHERE checksum = $1 AND org_id = $2`,
          [row.checksum, orgId],
        );

        return row;
      });

      if (!document) throw notFound('Document');
      return { data: { archived: true, retained_days: 30 } };
    },
  );
}

function shape(document) {
  return {
    ...document,
    size_label: humanSize(document.byte_size),
    sheet_count: Array.isArray(document.sheet_profile) ? document.sheet_profile.length : 0,
    importable: document.kind === 'spreadsheet' && Array.isArray(document.sheet_profile) && document.sheet_profile.length > 0,
    // The full profile is large; the list only needs the shape of it.
    sheet_profile: undefined,
    sheets: Array.isArray(document.sheet_profile)
      ? document.sheet_profile.map((s) => ({
          name: s.name, total_rows: s.total_rows, columns: s.columns?.length ?? 0,
        }))
      : [],
  };
}
