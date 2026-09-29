#!/usr/bin/env node
/**
 * Import Notion task databases into Tasks & Boards.
 *
 *   node scripts/import-notion.js --owner admin@flpworldwide.com \
 *     --export notion-export.json --calendar calendar.json [--org <slug>] [--dry-run]
 *
 * Every Notion database becomes one PRIVATE board owned by --owner; every row
 * becomes a task on it. Notion properties with no column of their own (hours,
 * captions, links, blockers…) are kept in the task description, which also
 * ends with the Notion link the task came from.
 *
 * Idempotent: a board is matched by name and a task by its Notion link, so
 * running it again only adds what is new. It writes straight to the Tasks
 * tables (a one-off admin import, not an API client), so no notifications
 * are sent for imported tasks.
 */
import { readFileSync } from 'node:fs';
import { createDb, id } from '../packages/db-kit/src/index.js';
import { loadRootEnv } from './lib/services.js';

const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const dryRun = argv.includes('--dry-run');
const ownerEmail = arg('owner')?.toLowerCase();
if (!ownerEmail || !arg('export')) {
  console.error('usage: import-notion.js --owner <email> --export <file> [--calendar <file>] [--org <slug>] [--dry-run]');
  process.exit(1);
}

const exported = JSON.parse(readFileSync(arg('export'), 'utf8'));
// A saved Notion view-query result: [{ type: 'text', text: '{"results":[…]}' }] or { results: […] }.
const calendarRows = (() => {
  if (!arg('calendar')) return [];
  const raw = JSON.parse(readFileSync(arg('calendar'), 'utf8'));
  return (Array.isArray(raw) ? JSON.parse(raw[0].text) : raw).results ?? [];
})();

// ── Notion values → plain text ──────────────────────────────────────────────
const text = (value) => String(value ?? '')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, (_, label, url) => (label === url ? url : `${label} (${url})`))
  .trim();
const list = (value) => { try { return JSON.parse(value ?? '[]'); } catch { return []; } };
/** Calendar date in India, from a Notion date or date-time. */
const day = (value) => {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return new Date(new Date(value).getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
};
const people = (value) => list(value).map((ref) => exported.people?.[ref] ?? ref);
const section = (label, value) => (text(value) ? `${label}:\n${text(value)}` : null);
const field = (label, value) => (text(value) ? `${label}: ${text(value)}` : null);
const describe = (row, parts) => [...parts.filter(Boolean), `Imported from Notion: ${row.url}`].join('\n\n');

// ── one definition per Notion database ─────────────────────────────────────
const DAILY_STATUS = { Planned: 'todo', 'In Progress': 'in_progress', Completed: 'done', Blocked: 'blocked' };
const PRIORITY = { High: 'high', Medium: 'medium', Low: 'low' };
const daily = (row) => ({
  title: text(row.Task),
  status: DAILY_STATUS[row.Status] ?? 'todo',
  priority: PRIORITY[row.Priority] ?? 'medium',
  due_date: day(row['date:Work Date:start']),
  description: describe(row, [
    section('Task details', row['Task Details']),
    section('Outcome / update', row['Outcome / Update']),
    section('Blockers', row.Blockers),
    [field('Employee', people(row.Employee).join(', ')), field('Hours', row.Hours),
      `Submitted: ${row.Submitted === '__YES__' ? 'yes' : 'no'}`, field('Notion task ID', row['Task ID'])].filter(Boolean).join('\n'),
  ]),
});

const BOARDS = [
  {
    name: 'Todo', color: 'violet', rows: exported.todo ?? [],
    description: 'Imported from the Notion “Todo” database.',
    map: (row) => ({
      title: text(row.Task),
      status: { 'Not started': 'todo', 'In progress': 'in_progress', Done: 'done' }[row.Status] ?? 'todo',
      priority: 'medium',
      due_date: day(row['date:Date:start']),
      description: describe(row, []),
    }),
  },
  {
    name: 'Daily Work – HR', color: 'emerald', rows: exported.dailyHr ?? [], map: daily,
    description: 'Daily work log for HR (Notion “FLP Daily Work - HR”). Share with hr@flpworldwide.com once they join.',
  },
  {
    name: 'Daily Work – Support', color: 'blue', rows: exported.dailySupport ?? [], map: daily,
    description: 'Daily work log for Support (Notion “FLP Daily Work - Support”). Share with support@flpworldwide.com once they join.',
  },
  {
    name: 'Daily Work – Social Media', color: 'rose', rows: exported.dailySocial ?? [], map: daily,
    description: 'Daily work log for Social Media (Notion “FLP Daily Work - Social Media”). Share with socialmedia@flpworldwide.com once they join.',
  },
  {
    name: 'Social Media Calendar', color: 'amber', rows: calendarRows,
    description: 'Content pipeline from the Notion “FLP Social Media Calendar”. Status follows the Notion stage; the stage itself is kept in each task.',
    map: (row) => ({
      title: text(row.Topic),
      status: {
        Idea: 'todo', Draft: 'in_progress', 'Assets ready': 'in_progress', 'For review': 'in_progress',
        Approved: 'in_progress', Scheduled: 'in_progress', Published: 'done', 'Needs changes': 'blocked', 'Past idea': 'done',
      }[row.Stage] ?? 'todo',
      priority: row.Stage === 'Needs changes' || row.Approval === 'Changes requested' ? 'high' : 'medium',
      due_date: day(row['date:Publish date:start']),
      description: describe(row, [
        [field('Content ID', row['Content ID']), field('Stage', row.Stage), field('Approval', row.Approval),
          field('Format', row.Format), field('Pillar', row.Pillar), field('Platforms', list(row.Platform).join(', ')),
          field('Fact check', row['Fact check']), field('Owner', people(row.Owner).join(', '))].filter(Boolean).join('\n'),
        section('Hook', row.Hook), section('Caption', row.Caption), section('CTA', row.CTA),
        section('Script / outline', row['Script / outline']), section('Creative brief', row['Creative brief']),
        section('Changes requested', row.Changes), section('Notes', row.Notes),
        [field('Asset link', row['Asset link']), field('Published link', row['Published link'])].filter(Boolean).join('\n'),
      ]),
    }),
  },
  {
    name: 'Publishing Queue', color: 'orange', rows: exported.publishingQueue ?? [],
    description: 'Posts queued for Facebook and Instagram, from the Notion “FLP Publishing Queue”.',
    map: (row) => ({
      title: text(row.Post),
      status: { 'Awaiting approval': 'todo', Ready: 'todo', Scheduled: 'in_progress', Publishing: 'in_progress', Published: 'done', Blocked: 'blocked' }[row['Queue status']] ?? 'todo',
      priority: /^urgent/i.test(row.Blocker ?? '') ? 'urgent' : row['Queue status'] === 'Blocked' ? 'high' : 'medium',
      due_date: day(row['date:Publish at:start']),
      description: describe(row, [
        [field('Queue status', row['Queue status']), field('Format', row.Format), field('Platforms', list(row.Platforms).join(', ')),
          field('Publish at (UTC)', row['date:Publish at:start']), field('Meta scheduled IDs', row['Meta scheduled IDs'])].filter(Boolean).join('\n'),
        section('Blocker', row.Blocker), section('Caption', row.Caption), section('Asset links', row['Asset links']),
        [field('Facebook link', row['Facebook link']), field('Instagram link', row['Instagram link']),
          field('Source calendar row', row['Source row'])].filter(Boolean).join('\n'),
      ]),
    }),
  },
];

// ── write ───────────────────────────────────────────────────────────────────
const env = loadRootEnv();
if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required (single-database mode)');
const db = createDb({ url: env.DATABASE_URL, max: 2, schema: null });

try {
  const owner = await db.one(`SELECT id, name FROM nexus_identity.users WHERE email_normalized = $1 AND status <> 'deleted'`, [ownerEmail]);
  if (!owner) throw new Error(`no user ${ownerEmail}`);
  const org = await db.one(
    `SELECT o.id, o.name, o.slug FROM nexus_tenancy.organizations o
       JOIN nexus_tenancy.members m ON m.org_id = o.id AND m.user_id = $1 AND m.status = 'active'
      WHERE o.status = 'active' AND ($2::text IS NULL OR o.slug = $2) AND o.owner_user_id = $1
      ORDER BY o.created_at LIMIT 1`,
    [owner.id, arg('org') ?? null],
  );
  if (!org) throw new Error(`${ownerEmail} owns no active workspace${arg('org') ? ` with slug ${arg('org')}` : ''}`);

  const tasksOn = await db.one(
    `SELECT EXISTS (SELECT 1 FROM nexus_billing.app_entitlements WHERE org_id = $1 AND app_slug = 'tasks' AND status <> 'expired') AS entitled,
            EXISTS (SELECT 1 FROM nexus_catalog.organization_apps WHERE org_id = $1 AND app_slug = 'tasks' AND status = 'installed') AS installed`,
    [org.id],
  );
  console.log(`Workspace: ${org.name} (${org.slug}) · owner ${ownerEmail}${dryRun ? ' · DRY RUN' : ''}`);
  if (!tasksOn.entitled || !tasksOn.installed) {
    console.warn(`! Tasks & Boards is ${tasksOn.entitled ? '' : 'not on the subscription'}${!tasksOn.entitled && !tasksOn.installed ? ' and ' : ''}${tasksOn.installed ? '' : 'not installed'} — add it in Plan & billing to see these boards.`);
  }

  for (const board of BOARDS) {
    const tasks = board.rows.map(board.map).filter((t) => t.title);
    const skipped = board.rows.length - tasks.length;
    if (dryRun) {
      console.log(`  ${board.name.padEnd(28)} ${String(tasks.length).padStart(3)} tasks${skipped ? ` (${skipped} untitled skipped)` : ''}`);
      continue;
    }

    const result = await db.transaction(async (tx) => {
      let project = await tx.one(`SELECT * FROM nexus_tasks.projects WHERE org_id = $1 AND name = $2`, [org.id, board.name]);
      if (!project) {
        project = await tx.one(
          `INSERT INTO nexus_tasks.projects (id, org_id, name, description, visibility, color, created_by)
           VALUES ($1, $2, $3, $4, 'private', $5, $6) RETURNING *`,
          [id('prj'), org.id, board.name, board.description, board.color, owner.id],
        );
        await tx.query(
          `INSERT INTO nexus_tasks.project_members (org_id, project_id, user_id, role, added_by)
           VALUES ($1, $2, $3, 'owner', $3) ON CONFLICT DO NOTHING`,
          [org.id, project.id, owner.id],
        );
      }
      let added = 0;
      for (const task of tasks) {
        const notionUrl = task.description.split('Imported from Notion: ').pop();
        const exists = await tx.one(
          `SELECT 1 FROM nexus_tasks.tasks WHERE org_id = $1 AND project_id = $2 AND description LIKE '%' || $3`,
          [org.id, project.id, notionUrl],
        );
        if (exists) continue;
        await tx.query(
          `INSERT INTO nexus_tasks.tasks (id, org_id, project_id, title, description, status, priority, due_date, created_by, completed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $6 = 'done' THEN now() ELSE NULL END)`,
          [id('tsk'), org.id, project.id, task.title.slice(0, 200), task.description.slice(0, 20_000),
            task.status, task.priority, task.due_date, owner.id],
        );
        added += 1;
      }
      return { added, existing: tasks.length - added };
    });
    console.log(`  ${board.name.padEnd(28)} +${result.added} tasks${result.existing ? `, ${result.existing} already imported` : ''}${skipped ? `, ${skipped} untitled skipped` : ''}`);
  }
} finally {
  await db.close();
}
