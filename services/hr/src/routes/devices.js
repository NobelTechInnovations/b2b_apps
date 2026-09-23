import crypto from 'node:crypto';
import { id, paginate } from '@nexus/db-kit';
import {
  requirePermission, body, params, query, validate as v, notFound, badRequest, unauthorized,
} from '@nexus/service-kit';
import { shiftForEmployee, rebuildDay, ensureDefaultShift } from '../lib/shifts.js';
import { toISODate } from '../lib/setup.js';

/**
 * A device key is a machine credential, not a password: 32 random bytes, shown
 * once, stored only as a digest. There is no reset flow because there is no
 * user to reset it for — you rotate it and reconfigure the terminal.
 */
function mintKey() {
  const secret = `nxd_${crypto.randomBytes(24).toString('base64url')}`;
  return {
    secret,
    hash: crypto.createHash('sha256').update(secret).digest('hex'),
    hint: `${secret.slice(0, 8)}…${secret.slice(-4)}`,
  };
}

const hashKey = (secret) => crypto.createHash('sha256').update(secret).digest('hex');

export async function deviceRoutes(app) {
  const { db } = app;

  // ═══════════════════════════════════════════════════════════════ DEVICES
  app.get(
    '/hr/devices',
    { preHandler: [app.loadContext, requirePermission('hr.devices.view')] },
    async (request) => {
      const rows = await db.rows(
        `SELECT d.*,
                (SELECT count(*)::int FROM punches p
                  WHERE p.device_id = d.id AND p.punched_at > now() - interval '24 hours') AS punches_today
           FROM devices d
          WHERE d.org_id = $1
          ORDER BY d.status, d.name`,
        [request.ctx.orgId],
      );

      const unmatched = await db.one(
        `SELECT count(*)::int AS n FROM punches WHERE org_id = $1 AND status = 'unmatched'`,
        [request.ctx.orgId],
      );

      return {
        data: rows.map(({ api_key_hash, ...device }) => device),
        meta: {
          total: rows.length,
          unmatched_punches: unmatched.n,
          // Shown on the device setup card so nobody has to guess the URL.
          endpoint: '/api/device-sync/punches',
        },
      };
    },
  );

  app.post(
    '/hr/devices',
    {
      preHandler: [app.loadContext, requirePermission('hr.devices.manage')],
      schema: {
        body: body(
          {
            name: v.text(80, 1),
            location: v.text(120),
            serial: v.text(80),
            kind: v.enum(['biometric', 'rfid', 'face', 'mobile', 'manual']),
          },
          ['name'],
        ),
      },
    },
    async (request, reply) => {
      const { orgId, userId } = request.ctx;
      const key = mintKey();

      const device = await db.one(
        `INSERT INTO devices (id, org_id, name, location, serial, kind, api_key_hash, api_key_hint, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [
          id('dev'), orgId, request.body.name.trim(), request.body.location ?? null,
          request.body.serial ?? null, request.body.kind ?? 'biometric',
          key.hash, key.hint, userId,
        ],
      );

      const { api_key_hash: _drop, ...safe } = device;
      // The only time the plaintext key exists outside the terminal.
      return reply.status(201).send({ data: { ...safe, api_key: key.secret } });
    },
  );

  app.patch(
    '/hr/devices/:deviceId',
    {
      preHandler: [app.loadContext, requirePermission('hr.devices.manage')],
      schema: {
        params: params({ deviceId: v.id('dev') }),
        body: body({
          name: v.text(80, 1), location: v.text(120), serial: v.text(80),
          status: v.enum(['active', 'disabled']),
        }),
      },
    },
    async (request) => {
      const fields = ['name', 'location', 'serial', 'status'].filter((f) => request.body[f] !== undefined);
      if (!fields.length) throw badRequest('Nothing to update.');

      const sets = fields.map((f, i) => `${f} = $${i + 3}`).join(', ');
      const updated = await db.one(
        `UPDATE devices SET ${sets} WHERE id = $1 AND org_id = $2 RETURNING *`,
        [request.params.deviceId, request.ctx.orgId, ...fields.map((f) => request.body[f])],
      );
      if (!updated) throw notFound('Device');

      const { api_key_hash: _drop, ...safe } = updated;
      return { data: safe };
    },
  );

  /** Rotate the key. The old one stops working the moment this returns. */
  app.post(
    '/hr/devices/:deviceId/rotate-key',
    {
      preHandler: [app.loadContext, requirePermission('hr.devices.manage')],
      schema: { params: params({ deviceId: v.id('dev') }) },
    },
    async (request) => {
      const key = mintKey();
      const updated = await db.one(
        `UPDATE devices SET api_key_hash = $3, api_key_hint = $4
          WHERE id = $1 AND org_id = $2 RETURNING id, name, api_key_hint`,
        [request.params.deviceId, request.ctx.orgId, key.hash, key.hint],
      );
      if (!updated) throw notFound('Device');

      return { data: { ...updated, api_key: key.secret } };
    },
  );

  app.delete(
    '/hr/devices/:deviceId',
    {
      preHandler: [app.loadContext, requirePermission('hr.devices.manage')],
      schema: { params: params({ deviceId: v.id('dev') }) },
    },
    async (request) => {
      const row = await db.one(
        `DELETE FROM devices WHERE id = $1 AND org_id = $2 RETURNING id`,
        [request.params.deviceId, request.ctx.orgId],
      );
      if (!row) throw notFound('Device');
      // Punches survive: the attendance they produced must stay explainable.
      return { data: { deleted: true } };
    },
  );

  // ════════════════════════════════════════════════════════════ ENROLMENT
  /** The card / finger / face id a terminal knows somebody by. */
  app.get(
    '/hr/devices/identities',
    { preHandler: [app.loadContext, requirePermission('hr.devices.view')] },
    async (request) => {
      const rows = await db.rows(
        `SELECT di.employee_ref, di.employee_id, di.created_at,
                e.first_name, e.last_name, e.employee_code
           FROM device_identities di
           JOIN employees e ON e.id = di.employee_id
          WHERE di.org_id = $1
          ORDER BY e.first_name, di.employee_ref`,
        [request.ctx.orgId],
      );

      return {
        data: rows.map((r) => ({
          ...r,
          name: [r.first_name, r.last_name].filter(Boolean).join(' '),
        })),
      };
    },
  );

  /**
   * Map a device reference to a person, then adopt the punches that arrived
   * before the mapping existed. Enrolling somebody a week late should not cost
   * them a week of attendance.
   */
  app.post(
    '/hr/devices/identities',
    {
      preHandler: [app.loadContext, requirePermission('hr.devices.manage')],
      schema: {
        body: body({ employee_ref: v.text(80, 1), employee_id: v.id('emp') }, ['employee_ref', 'employee_id']),
      },
    },
    async (request, reply) => {
      const { orgId } = request.ctx;
      const ref = request.body.employee_ref.trim();
      await ensureDefaultShift(db, orgId);

      const employee = await db.one(
        `SELECT id FROM employees WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`,
        [request.body.employee_id, orgId],
      );
      if (!employee) throw notFound('Employee');

      const adopted = await db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO device_identities (org_id, employee_ref, employee_id)
           VALUES ($1,$2,$3)
           ON CONFLICT (org_id, employee_ref) DO UPDATE SET employee_id = EXCLUDED.employee_id`,
          [orgId, ref, employee.id],
        );

        const claimed = await tx.rows(
          `UPDATE punches SET employee_id = $3, status = 'matched'
            WHERE org_id = $1 AND employee_ref = $2 AND status = 'unmatched'
            RETURNING punched_at`,
          [orgId, ref, employee.id],
        );

        const dates = [...new Set(claimed.map((p) => new Date(p.punched_at).toISOString().slice(0, 10)))];
        for (const onDate of dates) {
          const shift = await shiftForEmployee(tx, orgId, employee.id, onDate);
          await rebuildDay(tx, { orgId, employeeId: employee.id, onDate, shift, recordedBy: 'enrolment' });
        }

        return { punches: claimed.length, days: dates.length };
      });

      return reply.status(201).send({
        data: { employee_ref: ref, employee_id: employee.id, ...adopted },
      });
    },
  );

  app.delete(
    '/hr/devices/identities/:employeeRef',
    {
      preHandler: [app.loadContext, requirePermission('hr.devices.manage')],
      schema: { params: params({ employeeRef: v.text(80, 1) }) },
    },
    async (request) => {
      const row = await db.one(
        `DELETE FROM device_identities WHERE org_id = $1 AND employee_ref = $2 RETURNING employee_ref`,
        [request.ctx.orgId, request.params.employeeRef],
      );
      if (!row) throw notFound('Enrolment');
      return { data: { deleted: true } };
    },
  );

  // ═══════════════════════════════════════════════════════════════ PUNCHES
  app.get(
    '/hr/punches',
    {
      preHandler: [app.loadContext, requirePermission('hr.attendance.view')],
      schema: {
        querystring: query({
          employee_id: v.id('emp'),
          device_id: v.id('dev'),
          status: v.enum(['matched', 'unmatched', 'duplicate', 'ignored']),
          from: v.date,
          to: v.date,
        }),
      },
    },
    async (request) => {
      const { orgId } = request.ctx;
      const page = paginate({ ...request.query, allowedSorts: ['punched_at', 'created_at'] });
      const qs = request.query;

      const where = ['p.org_id = $1'];
      const values = [orgId];
      if (qs.employee_id) { values.push(qs.employee_id); where.push(`p.employee_id = $${values.length}`); }
      if (qs.device_id) { values.push(qs.device_id); where.push(`p.device_id = $${values.length}`); }
      if (qs.status) { values.push(qs.status); where.push(`p.status = $${values.length}`); }
      if (qs.from) { values.push(qs.from); where.push(`p.punched_at >= $${values.length}::date`); }
      if (qs.to) { values.push(qs.to); where.push(`p.punched_at < $${values.length}::date + 1`); }

      const clause = where.join(' AND ');
      const join = `FROM punches p
                    LEFT JOIN employees e ON e.id = p.employee_id
                    LEFT JOIN devices dv ON dv.id = p.device_id`;

      const [rows, total] = await Promise.all([
        db.rows(
          `SELECT p.*, e.first_name, e.last_name, e.employee_code, dv.name AS device_name ${join}
            WHERE ${clause} ORDER BY p.${page.orderBy} LIMIT ${page.limit} OFFSET ${page.offset}`,
          values,
        ),
        db.one(`SELECT count(*)::int AS n ${join} WHERE ${clause}`, values),
      ]);

      return {
        data: rows.map((r) => ({
          ...r,
          name: r.first_name ? [r.first_name, r.last_name].filter(Boolean).join(' ') : null,
        })),
        meta: page.meta(total.n),
      };
    },
  );

  /** Re-derive a day from its punches — the fix for an edited or late punch. */
  app.post(
    '/hr/punches/rebuild',
    {
      preHandler: [app.loadContext, requirePermission('hr.attendance.edit')],
      schema: { body: body({ employee_id: v.id('emp'), on_date: v.date }, ['employee_id']) },
    },
    async (request) => {
      const { orgId } = request.ctx;
      const onDate = request.body.on_date ?? toISODate(new Date());

      const result = await db.transaction(async (tx) => {
        const shift = await shiftForEmployee(tx, orgId, request.body.employee_id, onDate);
        return rebuildDay(tx, { orgId, employeeId: request.body.employee_id, onDate, shift, recordedBy: 'rebuild' });
      });

      if (!result) throw badRequest('There are no punches on that date to rebuild from.');
      return { data: result };
    },
  );

  // ════════════════════════════════════════════════ DEVICE INGESTION (key)
  /**
   * The endpoint a terminal posts to.
   *
   * It carries no user token — there is no user — so it authenticates with the
   * device's own key and resolves the workspace from it. Two things make that
   * safe to expose: the gateway still proves itself with the internal service
   * token, and a key only ever unlocks the one workspace it was minted in.
   *
   * Devices retry aggressively and replay their buffer after a network drop,
   * so the same punch will arrive many times. The unique index makes that a
   * no-op rather than a duplicate day.
   */
  app.post(
    '/device-sync/punches',
    {
      schema: {
        body: body(
          {
            punches: {
              type: 'array',
              minItems: 1,
              maxItems: 500,
              items: {
                type: 'object',
                properties: {
                  employee_ref: { type: 'string', minLength: 1, maxLength: 80 },
                  punched_at: { type: 'string', format: 'date-time' },
                  direction: { type: 'string', enum: ['in', 'out'] },
                  raw: { type: 'object', additionalProperties: true },
                },
                required: ['employee_ref', 'punched_at'],
                additionalProperties: false,
              },
            },
          },
          ['punches'],
        ),
      },
    },
    async (request) => {
      // Gate 1: the request came through our own gateway.
      await app.verifyInternal(request);

      // Gate 2: the device is one we issued a key to, and it is still enabled.
      const presented = request.headers['x-device-key'];
      if (typeof presented !== 'string' || !presented) {
        throw unauthorized('This endpoint requires a device key.');
      }

      const device = await db.one(
        `SELECT * FROM devices WHERE api_key_hash = $1`,
        [hashKey(presented)],
      );
      if (!device) throw unauthorized('Unknown device key.');
      if (device.status !== 'active') throw unauthorized('This device has been disabled.');

      const orgId = device.org_id;

      const summary = await db.transaction(async (tx) => {
        const identities = await tx.rows(
          `SELECT employee_ref, employee_id FROM device_identities WHERE org_id = $1`,
          [orgId],
        );
        const byRef = new Map(identities.map((i) => [i.employee_ref, i.employee_id]));

        // A terminal is often configured with the employee code itself, so
        // fall back to that before giving up and parking the punch.
        const codes = await tx.rows(
          `SELECT id, employee_code FROM employees
            WHERE org_id = $1 AND archived_at IS NULL AND employee_code IS NOT NULL`,
          [orgId],
        );
        const byCode = new Map(codes.map((c) => [c.employee_code.toLowerCase(), c.id]));

        let accepted = 0;
        let duplicate = 0;
        let unmatched = 0;
        const affected = new Map();

        for (const punch of request.body.punches) {
          const ref = punch.employee_ref.trim();
          const employeeId = byRef.get(ref) ?? byCode.get(ref.toLowerCase()) ?? null;

          const inserted = await tx.one(
            `INSERT INTO punches
               (id, org_id, device_id, employee_id, employee_ref, punched_at, direction, status, raw)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             ON CONFLICT (org_id, employee_ref, punched_at) DO NOTHING
             RETURNING id`,
            [
              id('pnc'), orgId, device.id, employeeId, ref, punch.punched_at,
              punch.direction ?? null, employeeId ? 'matched' : 'unmatched',
              JSON.stringify(punch.raw ?? {}),
            ],
          );

          if (!inserted) { duplicate += 1; continue; }
          accepted += 1;
          if (!employeeId) { unmatched += 1; continue; }

          const onDate = new Date(punch.punched_at).toISOString().slice(0, 10);
          if (!affected.has(employeeId)) affected.set(employeeId, new Set());
          affected.get(employeeId).add(onDate);
        }

        // Only days that actually received a new punch are rebuilt.
        let daysRebuilt = 0;
        for (const [employeeId, dates] of affected) {
          for (const onDate of dates) {
            const shift = await shiftForEmployee(tx, orgId, employeeId, onDate);
            const day = await rebuildDay(tx, { orgId, employeeId, onDate, shift, recordedBy: device.id });
            if (day) daysRebuilt += 1;
          }
        }

        await tx.query(
          `UPDATE devices SET last_seen_at = now(), punch_count = punch_count + $2 WHERE id = $1`,
          [device.id, accepted],
        );

        return { accepted, duplicate, unmatched, days_rebuilt: daysRebuilt };
      });

      return {
        data: {
          device: device.name,
          received: request.body.punches.length,
          ...summary,
        },
      };
    },
  );
}
