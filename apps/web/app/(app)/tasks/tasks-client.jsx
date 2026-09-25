'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Plus, FolderKanban, ListChecks, CalendarDays, Timer, Kanban, ArrowLeft, ArrowRight, Paperclip, CheckCircle2, Circle, Search, SlidersHorizontal, GripVertical, ArrowUpRight, Flag } from 'lucide-react';
import { api } from '@/lib/api';
import { date as fmtDate } from '@/lib/format';
import { useWorkspace } from '@/lib/workspace';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/input';
import { Drawer } from '@/components/data/drawer';
import { Alert } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import styles from './tasks.module.css';

const STATUSES = { todo: 'To do', in_progress: 'In progress', blocked: 'Blocked', done: 'Done' };
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const VIEWS = [['work', '/tasks', 'My work', ListChecks], ['projects', '/tasks/projects', 'Projects', FolderKanban], ['board', '/tasks/board', 'Board', Kanban], ['calendar', '/tasks/calendar', 'Calendar', CalendarDays], ['time', '/tasks/time', 'Timesheets', Timer]];
const panel = styles.panel;
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const duration = minutes => `${Math.floor(Number(minutes ?? 0) / 60)}h ${Number(minutes ?? 0) % 60}m`;
const blankTime = () => ({ hours: '', minutes: '', worked_on: today(), note: '' });
const blankTask = () => ({ title: '', description: '', project_id: '', milestone_id: '', assignee_id: '', due_date: '', status: 'todo', priority: 'medium' });
function Label({ title, children }) { return <label className="block space-y-1.5 text-sm"><span className="font-medium">{title}</span>{children}</label>; }

export default function TasksClient({ view = 'work' }) {
  const { can, user, workspace } = useWorkspace();
  const toast = useToast();
  const requestSequence = useRef(0);
  const [searchTerm, setSearchTerm] = useState('');
  const [dragging, setDragging] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);
  const [tasks, setTasks] = useState([]), [projects, setProjects] = useState([]), [people, setPeople] = useState([]);
  const [times, setTimes] = useState([]), [meta, setMeta] = useState({}), [projectId, setProjectId] = useState('');
  const [search, setSearch] = useState(''), [mine, setMine] = useState(view === 'work'), [page, setPage] = useState(1);
  const [month, setMonth] = useState(today().slice(0, 7));
  const [error, setError] = useState(''), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(null), [detail, setDetail] = useState(null), [projectDraft, setProjectDraft] = useState(null);
  const [milestones, setMilestones] = useState([]), [documents, setDocuments] = useState([]);
  const [comment, setComment] = useState(''), [subtask, setSubtask] = useState(''), [documentId, setDocumentId] = useState('');
  const [time, setTime] = useState(blankTime);
  const [timeTask, setTimeTask] = useState(null);
  const [milestone, setMilestone] = useState({ title: '', due_date: '' });
  const [projectMilestones, setProjectMilestones] = useState([]);
  const active = workspace?.installed?.includes('tasks') && workspace?.apps?.includes('tasks');
  const required = view === 'projects' ? 'tasks.projects.view' : view === 'time' ? 'tasks.time.view' : 'tasks.tasks.view';

  const load = useCallback(async () => {
    if (!active || !can(required)) { setLoading(false); return; }
    const sequence = ++requestSequence.current;
    setLoading(true);
    try {
      const query = { limit: 100, page, q: searchTerm || undefined, project_id: projectId || undefined, mine: mine || undefined };
      if (view === 'calendar') { query.due_from = `${month}-01`; query.due_to = `${month}-${new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate()}`; }
      const [result, projectList] = await Promise.all([
        view === 'projects' ? Promise.resolve({ data: [], meta: {} }) : api.get(view === 'time' ? '/tasks/time' : '/tasks', { query: view === 'time' ? { page, limit: 100, project_id: projectId || undefined, mine: mine || undefined } : query }),
        can('tasks.projects.view') ? api.get('/tasks/projects') : Promise.resolve({ data: [] }),
      ]);
      if (sequence !== requestSequence.current) return;
      setProjects(projectList.data); setMeta(result.meta ?? {});
      if (view === 'time') setTimes(result.data); else setTasks(result.data);
    } catch (e) { if (sequence === requestSequence.current) setError(e.message); } finally { if (sequence === requestSequence.current) setLoading(false); }
  }, [active, can, required, page, searchTerm, projectId, mine, month, view]);
  useEffect(() => {
    const timer = setTimeout(() => setSearchTerm(search), 200);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!active) return;
    if (can('core.members.view')) api.get('/members', { query: { limit: 100 } }).then(r => setPeople(r.data ?? [])).catch(() => {});
    const params = new URL(window.location.href).searchParams;
    if (params.get('project')) setProjectId(params.get('project'));
    // A notification links straight to one task; open it, then tidy the URL
    // so a refresh does not keep reopening it.
    if (params.get('task')) {
      openTask(params.get('task'));
      window.history.replaceState(null, '', window.location.pathname);
    }
    if (params.get('create') === '1' && can('tasks.tasks.create')) {
      setDraft({ ...blankTask(), title: params.get('title') ?? '', source_app: params.get('source_app'), source_type: params.get('source_type'), source_id: params.get('source_id') });
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, [active, can]);
  useEffect(() => {
    setMilestones([]);
    if (draft?.project_id && can('tasks.projects.view')) api.get(`/tasks/projects/${draft.project_id}/milestones`).then(r => setMilestones(r.data)).catch(e => setError(e.message));
  }, [draft?.project_id, can]);
  useEffect(() => {
    setProjectMilestones([]);
    if (projectDraft?.id) api.get(`/tasks/projects/${projectDraft.id}/milestones`).then(r => setProjectMilestones(r.data)).catch(e => setError(e.message));
  }, [projectDraft?.id]);

  async function perform(action) {
    setBusy(true); setError('');
    try { await action(); await load(); toast.success('Changes saved'); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function openTask(taskId) {
    setError('');
    try {
      const r = await api.get(`/tasks/${taskId}`);
      setDetail(r.data); setDraft(null); setComment(''); setSubtask(''); setDocumentId('');
      if (can('documents.files.view') && workspace.installed.includes('documents')) {
        api.get('/documents', { query: { limit: 100 } }).then(r => setDocuments(r.data)).catch(() => setDocuments([]));
      }
    } catch (e) { setError(e.message); }
  }
  async function refreshDetail() { if (detail) setDetail((await api.get(`/tasks/${detail.id}`)).data); }
  async function saveTask(event) {
    event.preventDefault();
    await perform(async () => {
      const data = {};
      for (const key of ['title', 'description', 'status', 'priority']) data[key] = draft[key];
      for (const key of ['project_id', 'milestone_id', 'assignee_id', 'due_date']) data[key] = draft[key] || null;
      if (!draft.id && draft.source_app) for (const key of ['source_app', 'source_type', 'source_id']) data[key] = draft[key];
      if (draft.id) await api.patch(`/tasks/${draft.id}`, data); else await api.post('/tasks', data);
      setDraft(null); setDetail(null);
    });
  }
  function logTime(task) { setTime(blankTime()); setError(''); setTimeTask(task); }
  function setFilter(setter, value) { setter(value); setPage(1); }
  const personName = (personId) => personId === user?.id ? 'You' : people.find(p => p.user_id === personId)?.name ?? (personId ? 'Workspace member' : 'Unassigned');
  const sourceLink = detail?.source_app === 'hr' ? '/hr/employees' : detail?.source_type === 'deal' ? '/crm/deals' : '/crm/leads';
  const move = (taskId, status) => perform(() => api.patch(`/tasks/${taskId}`, { status }));
  const stats = meta.stats ?? {};
  const newTask = (status = 'todo') => { setDetail(null); setError(''); setDraft({ ...blankTask(), status, project_id: projectId, assignee_id: user.id }); };
  const initials = (name) => name.split(' ').map(part => part[0]).slice(0, 2).join('').toUpperCase();
  const taskCard = (task) => <article key={task.id} data-dragging={dragging === task.id} draggable={can('tasks.tasks.edit') && !busy}
    onDragStart={e => { e.dataTransfer.setData('text/plain', task.id); setDragging(task.id); }} onDragEnd={() => { setDragging(null); setDropTarget(null); }} className={styles.taskCard}>
    <div className={styles.cardEyebrow}><span>{task.project_name || (task.source_app ? `${task.source_app.toUpperCase()} follow-up` : 'Team task')}</span><GripVertical size={14} aria-hidden="true" /></div>
    <button onClick={() => openTask(task.id)} className={styles.taskTitle}>{task.title}</button>
    {task.description && <p className={styles.cardDescription}>{task.description}</p>}
    <div className={styles.cardTags}><span className={styles.priority} data-priority={task.priority}><Flag size={10} />{task.priority}</span>{task.parent_id && <span className={styles.subtaskTag}>Subtask</span>}</div>
    <div className={styles.cardFooter}><span className={styles.due} data-overdue={Boolean(task.due_date && task.due_date < today() && task.status !== 'done')}><CalendarDays size={13} />{task.due_date ? new Date(`${task.due_date}T12:00:00`).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' }) : 'No due date'}</span><span className={styles.avatar} title={personName(task.assignee_id)}>{task.assignee_id ? initials(personName(task.assignee_id)) : '–'}</span></div>
    {can('tasks.time.log') && <button className="mt-3 flex items-center gap-2 text-sm" onClick={() => logTime(task)}><Timer size={14} />Log time</button>}
    {can('tasks.tasks.edit') && <select aria-label={`Status for ${task.title}`} className={styles.statusSelect} value={task.status} disabled={busy} onChange={e => move(task.id, e.target.value)}>{Object.entries(STATUSES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>}
  </article>;

  if (!active) return <div className={panel}><h1 className="text-xl font-semibold">Projects & Tasks</h1><p className="my-3">Add and install this app to start managing your team’s work.</p><Link href="/apps"><Button>Open marketplace</Button></Link></div>;
  if (!can(required)) return <Alert tone="critical">You do not have permission to view this page.</Alert>;
  return <div className={styles.workspace}>
    <header className={styles.hero}>
      <div className={styles.heroTop}><div className={styles.eyebrow}><span className={styles.appMark}><FolderKanban size={17} /></span>PROJECTS & TASKS<span className={styles.heroDivider} />WORKSPACE</div><span className={styles.liveLabel}><span /> One workspace. Shared progress.</span></div>
      <div className={styles.headingRow}><div><h1>{view === 'board' ? 'A clear view of the work.' : view === 'work' ? 'Make room for your best work.' : view === 'projects' ? 'From ambition to done.' : view === 'calendar' ? 'See what’s coming next.' : 'Time, well accounted for.'}</h1><p>{view === 'board' ? 'Move priorities forward, one task at a time.' : 'Shared priorities. Clear ownership. Progress you can see.'}</p></div>
        <div className={styles.heroActions}>{can('tasks.projects.create') && <Button className={styles.secondaryAction} icon={FolderKanban} onClick={() => { setError(''); setProjectDraft({ name: '', description: '', due_date: '', status: 'active' }); }}>New project</Button>}{can('tasks.tasks.create') && <Button className={styles.primaryAction} icon={Plus} onClick={() => newTask()}>New task</Button>}</div>
      </div>
      <div className={styles.summary} aria-label="Workspace summary">
        {(view === 'projects' ? [[projects.filter(p => p.status === 'active').length, 'Active projects'], [projects.reduce((n,p) => n + p.task_count, 0), 'Tasks across projects'], [projects.reduce((n,p) => n + p.completed_count, 0), 'Tasks completed']] : view === 'time' ? [[duration(meta.minutes), 'Time logged'], [meta.total ?? 0, 'Entries']] : [[stats.open ?? 0, 'Open tasks'], [stats.in_progress ?? 0, 'In progress'], [stats.done ?? 0, 'Completed'], [stats.overdue ?? 0, 'Overdue']]).map(([value, label]) => <div key={label}><strong>{loading && !meta.total && !projects.length ? '—' : value}</strong><span>{label}</span></div>)}
        <p>{['board', 'work', 'calendar'].includes(view) ? 'For the current filters' : view === 'time' ? 'For the selected project and people' : 'Your workspace, at a glance'}</p>
      </div>
    </header>
    <nav className={styles.tabs} aria-label="Task views">{VIEWS.filter(([key]) => can(key === 'projects' ? 'tasks.projects.view' : key === 'time' ? 'tasks.time.view' : 'tasks.tasks.view')).map(([key, url, label, Icon]) => <Link key={key} href={url} aria-current={key === view ? 'page' : undefined}><Icon size={16} />{label}</Link>)}</nav>
    {error && <Alert tone="critical">{error}</Alert>}
    {view === 'work' && <p className="text-sm text-[var(--text-secondary)]">Choose a task to work on, then use Log time to record your actual effort. Having multiple assigned tasks does not start multiple timers.</p>}
    {!['projects', 'time'].includes(view) && <div className={styles.toolbar}><div className={styles.search}><Search size={16} /><input aria-label="Search tasks" placeholder="Find a task…" value={search} onChange={e => setFilter(setSearch, e.target.value)} /></div><div className={styles.filters}><SlidersHorizontal size={15} aria-hidden="true" /><select aria-label="Filter by project" value={projectId} onChange={e => setFilter(setProjectId, e.target.value)}><option value="">All projects</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select><label><input type="checkbox" checked={mine} onChange={e => setFilter(setMine, e.target.checked)} />Only mine</label>{view === 'calendar' && <input type="month" aria-label="Calendar month" value={month} onChange={e => { if (e.target.value) setFilter(setMonth, e.target.value); }} />}</div>{loading && <span className={styles.updating}>Updating…</span>}</div>}
    {loading && !tasks.length && !projects.length && !times.length ? <p className="py-12 text-center text-[var(--text-secondary)]">Loading your work…</p> : <>
      {view === 'projects' && <div className={styles.projectGrid}>{projects.map(p => <article className={styles.projectCard} key={p.id}><div className={styles.projectTop}><span className={styles.projectIcon}><FolderKanban size={22} /></span><span className={styles.projectStatus} data-status={p.status}>{p.status[0].toUpperCase() + p.status.slice(1)}</span></div><h2>{p.name}</h2><p className={styles.projectDescription}>{p.description || 'A shared space for the work ahead.'}</p><div className={styles.progressHeading}><span>Progress</span><strong>{p.task_count ? Math.round(p.completed_count / p.task_count * 100) : 0}%</strong></div><div className={styles.progressTrack}><div style={{ width: `${p.task_count ? p.completed_count / p.task_count * 100 : 0}%` }} /></div><div className={styles.projectMeta}><span><CheckCircle2 size={13} />{p.completed_count}/{p.task_count} tasks</span><span>{p.due_date || 'No deadline'}</span></div>{can('tasks.time.view') && <Link className="my-3 flex items-center gap-2 text-sm" href={`/tasks/time?project=${p.id}`}><Timer size={14} />{duration(p.logged_minutes)} logged · View time</Link>}<div className={styles.projectActions}>{can('tasks.projects.edit') && <button onClick={() => { setError(''); setProjectDraft(p); }}>Details & milestones</button>}<Link href={`/tasks/board?project=${p.id}`}>Open board <ArrowUpRight size={15} /></Link></div></article>)}{!projects.length && <div className={styles.emptyState}><FolderKanban size={32} /><h2>Your next project starts here.</h2><p>Create a project, define the milestones and bring the team together.</p></div>}</div>}
      {view === 'board' && <div className={styles.board}>{Object.entries(STATUSES).map(([status, label]) => <section key={status} className={styles.column} data-drop-target={dropTarget === status} onDragOver={e => { e.preventDefault(); if (dragging) setDropTarget(status); }} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setDropTarget(null); }} onDrop={e => { e.preventDefault(); const taskId = e.dataTransfer.getData('text/plain'); setDragging(null); setDropTarget(null); if (!busy && can('tasks.tasks.edit') && tasks.some(t => t.id === taskId)) move(taskId, status); }}><div className={styles.columnHeading}><h2><span className={styles.statusDot} data-status={status} />{label}<span className={styles.columnCount}>{tasks.filter(t => t.status === status).length}</span></h2>{can('tasks.tasks.create') && <button aria-label={`Add task to ${label}`} onClick={() => newTask(status)}><Plus size={16} /></button>}</div><div className={styles.columnTasks}>{tasks.filter(t => t.status === status).map(taskCard)}{!tasks.some(t => t.status === status) && <div className={styles.emptyColumn}><Circle size={18} /><span>No tasks here yet</span><small>{status === 'done' ? 'Finished work finds its home here.' : 'Drop a task here to move it.'}</small></div>}</div></section>)}</div>}
      {view === 'work' && (tasks.length ? <div className={styles.list}><div className={styles.listHeader}><span>Task</span><span>Status</span><span>Priority</span><span>Due date</span><span>Owner / time</span></div>{tasks.map(task => <div key={task.id} className={styles.listRow}><button onClick={() => openTask(task.id)} className={styles.listTitle}>{task.status === 'done' ? <CheckCircle2 size={18} /> : <Circle size={18} />}<span><strong>{task.title}</strong><small>{task.project_name || 'No project'}</small></span></button><span className={styles.listStatus}><span className={styles.statusDot} data-status={task.status} />{STATUSES[task.status]}</span><span><span className={styles.priority} data-priority={task.priority}>{task.priority}</span></span><span className={styles.due} data-overdue={Boolean(task.due_date && task.due_date < today() && task.status !== 'done')}>{task.due_date || '—'}</span><div><span className={styles.avatar} title={personName(task.assignee_id)}>{task.assignee_id ? initials(personName(task.assignee_id)) : '–'}</span>{can('tasks.time.log') && <button className="mt-2 text-xs underline" onClick={() => logTime(task)}>Log time</button>}</div></div>)}</div> : <div className={styles.emptyState}><ListChecks size={34} /><h2>A little breathing room.</h2><p>No tasks match this view. Adjust the filters or create something new.</p>{can('tasks.tasks.create') && <Button onClick={() => newTask()} icon={Plus}>Create a task</Button>}</div>)}
      {view === 'calendar' && <Calendar month={month} tasks={tasks} onOpen={openTask} />}
      {view === 'time' && <div className={panel}>
        <h2 className="text-lg font-semibold">Time you and your team recorded</h2>
        <p className="my-3 text-sm text-[var(--text-secondary)]">Time is entered manually after you work. Assigning a task or changing its status does not start a timer. Project time is the sum of entries on its tasks and subtasks, including archived tasks.</p>
        <p className="mb-4 text-sm">Working on two tasks? Log the actual time separately: 30 minutes on Task A + 45 minutes on Task B = 1h 15m for their project. Do not enter the same work time on both tasks.</p>
        <div className="mb-5 flex flex-wrap items-center gap-4"><Select aria-label="Time project" value={projectId} onChange={e => setFilter(setProjectId,e.target.value)}><option value="">All projects</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</Select><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={mine} onChange={e => setFilter(setMine,e.target.checked)} />Only my entries</label><strong>{duration(meta.minutes)} total</strong><Link href="/tasks" className="text-sm underline">Go to My work to log time</Link></div>
        <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b"><th className="p-3">Date</th><th>Task / project</th><th>Person</th><th>Time spent</th><th>Note</th></tr></thead><tbody>{times.map(entry => <tr className="border-b border-[var(--border-default)]" key={entry.id}><td className="p-3">{entry.worked_on}</td><td><button className="text-[var(--text-brand)]" onClick={() => openTask(entry.task_id)}>{entry.title}</button><p className="text-xs text-[var(--text-secondary)]">{entry.project_name || 'No project'}</p></td><td>{personName(entry.user_id)}</td><td>{duration(entry.minutes)}</td><td>{entry.note}</td></tr>)}</tbody></table></div>{!times.length && <p className="py-8 text-center">No time logged here yet. Choose Log time on a task when you finish working on it.</p>}
      </div>}
      {view !== 'projects' && <div className="flex items-center justify-between text-sm text-[var(--text-secondary)]"><span>{meta.total ?? 0} records · Page {page}{view === 'calendar' ? ' · Tasks with a due date in this month' : ''}</span><div className="flex gap-2"><Button size="sm" icon={ArrowLeft} disabled={page === 1} onClick={() => setPage(p => p - 1)}>Previous</Button><Button size="sm" icon={ArrowRight} disabled={page * 100 >= (meta.total ?? 0)} onClick={() => setPage(p => p + 1)}>Next</Button></div></div>}
    </>}
    <Drawer className={styles.drawer} open={Boolean(draft)} onClose={() => { if (!busy) setDraft(null); }} title={draft?.id ? 'Edit task' : 'New task'}>
      {draft && <form onSubmit={saveTask} className={styles.editorForm}>{error && <Alert tone="critical">{error}</Alert>}
        <Label title="Title"><Input required data-autofocus placeholder="What needs to get done?" maxLength={200} value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })} /></Label>
        <Label title="Description"><Textarea rows={4} placeholder="Add context, a checklist or a useful detail…" value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })} /></Label>
        <Label title="Project"><Select value={draft.project_id ?? ''} onChange={e => setDraft({ ...draft, project_id: e.target.value, milestone_id: '' })}><option value="">No project</option>{projects.filter(p => p.status === 'active' || p.id === draft.project_id).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Label>
        <Label title="Milestone"><Select value={draft.milestone_id ?? ''} onChange={e => setDraft({ ...draft, milestone_id: e.target.value })}><option value="">No milestone</option>{milestones.map(m => <option key={m.id} value={m.id}>{m.title}</option>)}</Select></Label>
        <div className="grid grid-cols-2 gap-4"><Label title="Status"><Select value={draft.status} onChange={e => setDraft({ ...draft, status: e.target.value })}>{Object.entries(STATUSES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select></Label><Label title="Priority"><Select value={draft.priority} onChange={e => setDraft({ ...draft, priority: e.target.value })}>{PRIORITIES.map(p => <option key={p}>{p}</option>)}</Select></Label></div>
        <Label title="Assignee"><Select value={draft.assignee_id ?? ''} onChange={e => setDraft({ ...draft, assignee_id: e.target.value })}><option value="">Unassigned</option><option value={user.id}>You</option>{can('tasks.tasks.assign') && people.filter(p => p.user_id !== user.id && p.status === 'active').map(p => <option key={p.user_id} value={p.user_id}>{p.name ?? p.email}</option>)}{draft.assignee_id && draft.assignee_id !== user.id && !people.some(p => p.user_id === draft.assignee_id) && <option value={draft.assignee_id}>Current assignee</option>}</Select></Label>
        <Label title="Due date"><Input type="date" value={draft.due_date ?? ''} onChange={e => setDraft({ ...draft, due_date: e.target.value })} /></Label>
        {draft.source_app && <p className="text-sm text-[var(--text-secondary)]">Linked to {draft.source_app.toUpperCase()} · {draft.source_type}</p>}
        <Button type="submit" variant="primary" loading={busy}>Save task</Button>
      </form>}
    </Drawer>
    <Drawer className={styles.drawer} open={Boolean(detail) && !draft && !timeTask} onClose={() => { if (!busy) setDetail(null); }} title={detail?.title} subtitle={detail ? `${STATUSES[detail.status]} · ${detail.priority} priority` : ''}>
      {detail && <div className="space-y-6">{error && <Alert tone="critical">{error}</Alert>}
        <div className="flex flex-wrap gap-2">{can('tasks.tasks.edit') && <Button onClick={() => { setDraft(detail); setDetail(null); }}>Edit task</Button>}{can('tasks.tasks.delete') && <Button variant="danger-ghost" disabled={busy} onClick={() => perform(async () => { await api.del(`/tasks/${detail.id}`); setDetail(null); })}>Archive task</Button>}</div>
        <p className="whitespace-pre-wrap text-sm">{detail.description || 'No description yet.'}</p><div className="text-sm text-[var(--text-secondary)]">Assigned to {personName(detail.assignee_id)} · {detail.due_date ? `Due ${fmtDate(detail.due_date)}` : 'No deadline'}</div>
        {detail.source_app && <Link href={sourceLink} className="text-sm text-[var(--text-brand)]">Open linked {detail.source_app.toUpperCase()} {detail.source_type} list →</Link>}
        <section className="space-y-3"><h3 className="font-semibold">Subtasks</h3>{detail.subtasks.map(t => <button key={t.id} className="block text-sm text-[var(--text-brand)]" onClick={() => openTask(t.id)}>{t.status === 'done' ? '✓ ' : '○ '}{t.title}</button>)}{can('tasks.tasks.create') && detail.status !== 'done' && <form className="flex gap-2" onSubmit={e => { e.preventDefault(); perform(async () => { await api.post('/tasks', { title: subtask, parent_id: detail.id }); setSubtask(''); await refreshDetail(); }); }}><Input required aria-label="Subtask title" placeholder="Add a subtask" value={subtask} onChange={e => setSubtask(e.target.value)} /><Button type="submit" loading={busy}>Add</Button></form>}</section>
        <section className="space-y-3"><h3 className="font-semibold">Comments</h3>{detail.comments.map(c => <div key={c.id} className="rounded-lg bg-[var(--surface-sunken)] p-3 text-sm"><p className="whitespace-pre-wrap">{c.body}</p><p className="mt-2 text-xs text-[var(--text-tertiary)]">{personName(c.created_by)} · {fmtDate(c.created_at, 'datetime')}</p></div>)}{can('tasks.tasks.edit') && <form onSubmit={e => { e.preventDefault(); perform(async () => { await api.post(`/tasks/${detail.id}/comments`, { body: comment }); setComment(''); await refreshDetail(); }); }} className="space-y-2"><Textarea required aria-label="Comment" placeholder="Share an update…" value={comment} onChange={e => setComment(e.target.value)} /><Button type="submit" loading={busy}>Post comment</Button></form>}</section>
        {can('tasks.time.view') && <section className="space-y-2"><h3 className="font-semibold">Time on this task: {duration(detail.time_entries.reduce((sum, entry) => sum + entry.minutes, 0))}</h3>{detail.time_entries.map(t => <p key={t.id} className="text-sm">{t.worked_on} · {duration(t.minutes)} · {personName(t.user_id)} {t.note && `— ${t.note}`}</p>)}{!detail.time_entries.length && <p className="text-sm text-[var(--text-secondary)]">No time entries yet.</p>}</section>}
        {can('tasks.time.log') && <Button icon={Timer} onClick={() => logTime(detail)}>Log time on this task</Button>}
        <section className="space-y-3"><h3 className="flex items-center gap-2 font-semibold"><Paperclip size={16} />Documents</h3>{detail.attachments.map(a => <div key={a.id} className="flex items-center justify-between text-sm"><a className="text-[var(--text-brand)]" href={`${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'}/api/documents/${a.document_id}/download`} target="_blank" rel="noreferrer">{a.name}</a>{can('tasks.tasks.edit') && <Button size="xs" disabled={busy} onClick={() => perform(async () => { await api.del(`/tasks/${detail.id}/attachments/${a.id}`); await refreshDetail(); })}>Unlink</Button>}</div>)}{can('tasks.tasks.edit') && can('documents.files.view') && <form className="flex gap-2" onSubmit={e => { e.preventDefault(); perform(async () => { await api.post(`/tasks/${detail.id}/attachments`, { document_id: documentId }); await refreshDetail(); }); }}><Select required aria-label="Document to attach" value={documentId} onChange={e => setDocumentId(e.target.value)}><option value="">Choose a workspace document</option>{documents.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</Select><Button type="submit" loading={busy}>Attach</Button></form>}<p className="text-xs text-[var(--text-secondary)]">Upload files in Documents, then link them here. Downloads retain Documents permissions.</p></section>
      </div>}
    </Drawer>
    <Drawer className={styles.drawer} open={Boolean(timeTask)} onClose={() => { if (!busy) setTimeTask(null); }} title="Log time" subtitle={timeTask?.title}>
      {timeTask && <form className="space-y-5" onSubmit={e => { e.preventDefault(); const minutes = Number(time.hours || 0) * 60 + Number(time.minutes || 0); if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) { setError('Enter time between 1 minute and 24 hours.'); return; } perform(async () => { await api.post(`/tasks/${timeTask.id}/time`, { minutes, worked_on: time.worked_on, note: time.note }); setTimeTask(null); setDetail(null); }); }}>
        {error && <Alert tone="critical">{error}</Alert>}
        <p className="text-sm">Enter the time you actually spent on <strong>{timeTask.title}</strong>. This adds one entry to this task, not to your other assigned tasks.</p>
        <div className="grid grid-cols-2 gap-4"><Label title="Hours"><Input data-autofocus type="number" min="0" max="24" step="1" placeholder="0" value={time.hours} onChange={e => setTime({ ...time, hours: e.target.value })} /></Label><Label title="Minutes"><Input type="number" min="0" max="59" step="1" placeholder="0" value={time.minutes} onChange={e => setTime({ ...time, minutes: e.target.value })} /></Label></div>
        <div className="flex gap-2">{[15,30,60].map(n => <Button key={n} type="button" variant="secondary" onClick={() => setTime({ ...time, hours: String(Math.floor(n/60)), minutes: String(n%60) })}>{n === 60 ? '1 hour' : `${n} min`}</Button>)}</div>
        <Label title="Date worked"><Input required type="date" value={time.worked_on} onChange={e => setTime({ ...time, worked_on: e.target.value })} /></Label>
        <Label title="What did you work on? (optional)"><Textarea maxLength={1000} value={time.note} onChange={e => setTime({ ...time, note: e.target.value })} /></Label>
        <p className="text-sm font-medium">Adding {duration(Number(time.hours || 0)*60 + Number(time.minutes || 0))} to this task</p>
        <div className="flex gap-2"><Button type="submit" variant="primary" loading={busy}>Save time entry</Button><Button type="button" disabled={busy} onClick={() => setTimeTask(null)}>Cancel</Button></div>
      </form>}
    </Drawer>
    <Drawer className={styles.drawer} open={Boolean(projectDraft)} onClose={() => { if (!busy) setProjectDraft(null); }} title={projectDraft?.id ? 'Project details' : 'New project'}>
      {projectDraft && <div className="space-y-6">{error && <Alert tone="critical">{error}</Alert>}<form className="space-y-4" onSubmit={e => { e.preventDefault(); perform(async () => { const data = { name: projectDraft.name, description: projectDraft.description, due_date: projectDraft.due_date || null }; if (projectDraft.id) data.status = projectDraft.status; const r = projectDraft.id ? await api.patch(`/tasks/projects/${projectDraft.id}`, data) : await api.post('/tasks/projects', data); setProjectDraft(r.data); }); }}><Label title="Project name"><Input required data-autofocus placeholder="Give this project a clear name" value={projectDraft.name} onChange={e => setProjectDraft({ ...projectDraft, name: e.target.value })} /></Label><Label title="Description"><Textarea value={projectDraft.description} onChange={e => setProjectDraft({ ...projectDraft, description: e.target.value })} /></Label><Label title="Deadline"><Input type="date" value={projectDraft.due_date ?? ''} onChange={e => setProjectDraft({ ...projectDraft, due_date: e.target.value })} /></Label>{projectDraft.id && <Label title="Status"><Select value={projectDraft.status} onChange={e => setProjectDraft({ ...projectDraft, status: e.target.value })}>{['active', 'completed', 'archived'].map(s => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}</Select></Label>}<Button type="submit" variant="primary" loading={busy}>Save project</Button></form>
        {projectDraft.id && <section className="space-y-3"><h3 className="font-semibold">Milestones</h3>{projectMilestones.map(m => <label key={m.id} className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={busy} checked={m.completed} onChange={e => perform(async () => { await api.patch(`/tasks/milestones/${m.id}`, { completed: e.target.checked }); setProjectMilestones((await api.get(`/tasks/projects/${projectDraft.id}/milestones`)).data); })} />{m.title} {m.due_date && `· ${m.due_date}`}</label>)}{projectDraft.status === 'active' && <form className="space-y-3" onSubmit={e => { e.preventDefault(); perform(async () => { await api.post(`/tasks/projects/${projectDraft.id}/milestones`, { title: milestone.title, due_date: milestone.due_date || null }); setMilestone({ title: '', due_date: '' }); setProjectMilestones((await api.get(`/tasks/projects/${projectDraft.id}/milestones`)).data); }); }}><Label title="Milestone title"><Input required value={milestone.title} onChange={e => setMilestone({ ...milestone, title: e.target.value })} /></Label><Label title="Milestone deadline"><Input type="date" value={milestone.due_date} onChange={e => setMilestone({ ...milestone, due_date: e.target.value })} /></Label><Button type="submit" loading={busy}>Add milestone</Button></form>}</section>}
      </div>}
    </Drawer>
  </div>;
}

function Calendar({ month, tasks, onOpen }) {
  const [year, monthNumber] = month.split('-').map(Number);
  const start = new Date(year, monthNumber - 1, 1).getDay();
  const count = new Date(year, monthNumber, 0).getDate();
  return <div className="overflow-x-auto"><div className="grid min-w-[700px] grid-cols-7 gap-px overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--border-default)]">{['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => <div key={d} className="bg-[var(--surface-raised)] p-3 text-sm font-semibold">{d}</div>)}{Array.from({ length: Math.ceil((start + count) / 7) * 7 }, (_, i) => { const day = i - start + 1; const date = `${month}-${String(day).padStart(2, '0')}`; return <div key={i} className="min-h-28 bg-[var(--surface-raised)] p-2">{day > 0 && day <= count && <><span className={`mb-2 inline-block text-xs ${date === today() ? 'rounded-full bg-violet-600 px-2 py-1 text-white' : ''}`}>{day}</span>{tasks.filter(t => t.due_date === date).map(t => <button key={t.id} onClick={() => onOpen(t.id)} className={`mb-1 block w-full rounded p-1.5 text-left text-xs ${t.status === 'done' ? 'bg-green-100 text-green-900' : 'bg-violet-100 text-violet-900'}`}>{t.title}</button>)}</>}</div>; })}</div></div>;
}
