import { id } from '@nexus/db-kit';

/**
 * A workspace gets a working pipeline the first time it opens CRM, so the
 * board is never an empty shell asking you to configure it before you can
 * record your first deal.
 */
const DEFAULT_STAGES = [
  { name: 'Qualified',   probability: 10,  kind: 'open', colour: 'slate' },
  { name: 'Contacted',   probability: 25,  kind: 'open', colour: 'sky' },
  { name: 'Demo',        probability: 45,  kind: 'open', colour: 'indigo' },
  { name: 'Proposal',    probability: 65,  kind: 'open', colour: 'violet' },
  { name: 'Negotiation', probability: 85,  kind: 'open', colour: 'amber' },
  { name: 'Won',         probability: 100, kind: 'won',  colour: 'emerald' },
  { name: 'Lost',        probability: 0,   kind: 'lost', colour: 'rose' },
];

/** Idempotent: safe to call on every request that needs a pipeline. */
export async function ensureDefaultPipeline(db, orgId) {
  const existing = await db.one(
    `SELECT id FROM pipelines WHERE org_id = $1 AND is_default LIMIT 1`,
    [orgId],
  );
  if (existing) return existing.id;

  return db.transaction(async (tx) => {
    // Re-check inside the transaction: two first-time requests can race.
    const raced = await tx.one(
      `SELECT id FROM pipelines WHERE org_id = $1 AND is_default LIMIT 1`,
      [orgId],
    );
    if (raced) return raced.id;

    const pipeline = await tx.one(
      `INSERT INTO pipelines (id, org_id, name, is_default, position)
       VALUES ($1, $2, 'Sales pipeline', true, 0) RETURNING id`,
      [id('pip'), orgId],
    );

    for (const [index, stage] of DEFAULT_STAGES.entries()) {
      await tx.query(
        `INSERT INTO stages (id, org_id, pipeline_id, name, position, probability, kind, colour)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id('stg'), orgId, pipeline.id, stage.name, index, stage.probability, stage.kind, stage.colour],
      );
    }

    return pipeline.id;
  });
}

export async function loadPipeline(db, orgId, pipelineId) {
  const targetId = pipelineId ?? (await ensureDefaultPipeline(db, orgId));

  const pipeline = await db.one(
    `SELECT * FROM pipelines WHERE id = $1 AND org_id = $2`,
    [targetId, orgId],
  );
  if (!pipeline) return null;

  const stages = await db.rows(
    `SELECT * FROM stages WHERE org_id = $1 AND pipeline_id = $2 ORDER BY position`,
    [orgId, targetId],
  );

  return { ...pipeline, stages };
}

/**
 * Board position for a card dropped between two others.
 *
 * Midpoint of its neighbours, so a drag writes exactly one row instead of
 * renumbering the column. Falls back to a renumber only when the gap between
 * neighbours collapses below float precision.
 */
export function positionBetween(before, after) {
  if (before == null && after == null) return 1000;
  if (before == null) return after / 2;
  if (after == null) return before + 1000;

  const midpoint = (before + after) / 2;
  return midpoint === before || midpoint === after ? null : midpoint;
}

export async function renumberStage(tx, orgId, stageId) {
  const rows = await tx.rows(
    `SELECT id FROM deals
      WHERE org_id = $1 AND stage_id = $2 AND archived_at IS NULL
      ORDER BY board_position, created_at`,
    [orgId, stageId],
  );

  for (const [index, row] of rows.entries()) {
    await tx.query(`UPDATE deals SET board_position = $3 WHERE id = $1 AND org_id = $2`, [
      row.id,
      orgId,
      (index + 1) * 1000,
    ]);
  }

  return rows.length;
}
