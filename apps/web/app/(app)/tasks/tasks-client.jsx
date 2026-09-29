'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Plus, FolderKanban, ListChecks, CalendarDays, Timer, Kanban, ArrowLeft, ArrowRight, Paperclip,
  CheckCircle2, Circle, Search, SlidersHorizontal, GripVertical, ArrowUpRight, Flag, Lock, Globe2,
  Users, Table2, Settings2, UserPlus, Trash2, AlertCircle,
} from 'lucide-react';
import { api } from '@/lib/api';
import { API_BASE } from '@/lib/api-base';
import { date as fmtDate } from '@/lib/format';
import { useWorkspace } from '@/lib/workspace';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/input';
import { Drawer } from '@/components/data/drawer';
import { Alert } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import styles from './tasks.module.css';

const STATUSES = { todo: 'To do', in_progress: 'Working on it', blocked: 'Stuck', done: 'Done' };
const GROUP_COLORS = { todo: '#579bfc', in_progress: '#fdab3d', blocked: '#e2445c', done: '#00c875' };
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const COLORS = ['violet', 'indigo', 'blue', 'cyan', 'emerald', 'amber', 'orange', 'rose', 'slate'];
const ROLES = { owner: 'Owner', editor: 'Editor', viewer: 'Viewer' };
const VIEWS = [['work', '/tasks', 'My work', ListChecks], ['projects', '/tasks/projects', 'Boards', FolderKanban], ['board', '/tasks/board', 'Kanban & table', Kanban], ['calendar', '/tasks/calendar', 'Calendar', CalendarDays], ['time', '/tasks/time', 'Timesheets', Timer]];
const panel = styles.panel;
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const duration = minutes => `${Math.floor(Number(minutes ?? 0) / 60)}h ${Number(minutes ?? 0) % 60}m`;
const blankTime = () => ({ hours: '', minutes: '', worked_on: today(), note: '' });
const blankTask = () => ({ title: '', description: '', project_id: '', milestone_id: '', assignee_id: '', due_date: '', status: 'todo', priority: 'medium' });
const blankBoard = () => ({ name: '', description: '', due_date: '', status: 'active', visibility: 'private', color: 'violet', members: [] });
const initials = (name) => (name ?? '?').split(/[\s@.]+/).filter(Boolean).map(part => part[0]).slice(0, 2).join('').toUpperCase();
function Label({ title, children }) { return <label className="block space-y-1.5 text-sm"><span className="font-medium">{title}</span>{children}</label>; }

export default function TasksClient({ view = 'work' }) {
  const { can, user, workspace } = useWorkspace();
  const toast = useToast();
  const requestSequence = useRef(0);
  const [searchTerm, setSearchTerm] = useState('');
  const [dragging, setDragging] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);
  const [tasks, setTasks] = useState([]), [projects, setProjects] = useState([]), [people, setPeople] = useState([]);
  const [manageAll, setManageAll] = useState(false);
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
  const [layout, setLayout] = useState('kanban');
  const [sharing, setSharing] = useState(null);
  const [invitee, setInvitee] = useState({ user_id: '', role: 'editor' });
  const [quickAdd, setQuickAdd] = useState({});
  const active = workspace?.installed?.includes('tasks') && workspace?.apps?.includes('tasks');
  const required = view === 'projects' ? 'tasks.projects.view' : view === 'time' ? 'tasks.time.view' : 'tasks.tasks.view';
  const currentBoard = projects.find(p => p.id === projectId) ?? null;

  const load = useCallback(async () => {
    if (!active || !can(required)) { setLoading(false); return; }
    const sequence = ++requestSequence.current;
    setLoading(true);
    try {
      const query = { limit: 100, page, q: searchTerm || undefined, project_id: projectId || undefined, mine: mine || undefined };
      if (view === 'calendar') { query.due_from = `${month}-01`; query.due_to = `${month}-${new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate()}`; }
      const [result, projectList] = await Promise.all([
        view === 'projects' ? Promise.resolve({ data: [], meta: {} }) : api.get(view === 'time' ? '/tasks/time' : '/tasks', { query: view === 'time' ? { page, limit: 100, project_id: projectId || undefined, mine: mine || undefined } : query }),
        can('tasks.projects.view') ? api.get('/tasks/projects') : Promise.resolve({ data: [], meta: {} }),
      ]);
      if (sequence !== requestSequence.current) return;
      setProjects(projectList.data); setManageAll(Boolean(projectList.meta?.manage_all)); setMeta(result.meta ?? {});
      if (view === 'time') setTimes(result.data); else setTasks(result.data);
    } catch (e) {
      if (sequence !== requestSequence.current) return;
      // A board that was shared and then taken away simply disappears.
      if (e.status === 404 && projectId) { setProjectId(''); return; }
      setError(e.message);
    } finally { if (sequence === requestSequence.current) setLoading(false); }
  }, [active, can, required, page, searchTerm, projectId, mine, month, view]);

  const loadPeople = useCallback(async () => {
    const [members, boardPeople] = await Promise.all([
      can('core.members.view') ? api.get('/members', { query: { limit: 100 } }).then(r => r.data ?? []).catch(() => []) : Promise.resolve([]),
      api.get('/tasks/people').then(r => r.data ?? []).catch(() => []),
    ]);
    const byId = new Map();
    for (const p of boardPeople) byId.set(p.user_id, { user_id: p.user_id, name: p.name, email: p.email, status: 'active' });
    for (const m of members) byId.set(m.user_id, { ...byId.get(m.user_id), ...m });
    setPeople([...byId.values()]);
  }, [can]);

  useEffect(() => {
    const timer = setTimeout(() => setSearchTerm(search), 200);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    try { setLayout(localStorage.getItem('nexus-board-layout') === 'table' ? 'table' : 'kanban'); } catch { /* per-viewer nicety only */ }
  }, []);
  useEffect(() => {
    if (!active) return;
    loadPeople();
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
  }, [active, can, loadPeople]);
  // The board view always shows one board, Monday-style: the first one you can see.
  useEffect(() => {
    if (view === 'board' && !projectId && projects.length && !new URL(window.location.href).searchParams.get('all')) {
      setProjectId((projects.find(p => p.status === 'active') ?? projects[0]).id);
    }
  }, [view, projectId, projects]);
  useEffect(() => {
    setMilestones([]);
    if (draft?.project_id && can('tasks.projects.view')) api.get(`/tasks/projects/${draft.project_id}/milestones`).then(r => setMilestones(r.data)).catch(e => setError(e.message));
  }, [draft?.project_id, can]);
  useEffect(() => {
    setProjectMilestones([]);
    if (projectDraft?.id) api.get(`/tasks/projects/${projectDraft.id}/milestones`).then(r => setProjectMilestones(r.data)).catch(e => setError(e.message));
  }, [projectDraft?.id]);

  async function perform(action, message = 'Changes saved') {
    setBusy(true); setError('');
    try { await action(); await load(); toast.success(message); return true; } catch (e) { setError(e.message); toast.error(e.message); return false; } finally { setBusy(false); }
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
  async function openSharing(board) {
    setError(''); setInvitee({ user_id: '', role: 'editor' });
    try { setSharing((await api.get(`/tasks/projects/${board.id}`)).data); } catch (e) { setError(e.message); }
  }
  async function refreshSharing() { if (sharing) setSharing((await api.get(`/tasks/projects/${sharing.id}`)).data); await loadPeople(); }
  function saveBoard(event) {
    event.preventDefault();
    perform(async () => {
      const data = { name: projectDraft.name, description: projectDraft.description, due_date: projectDraft.due_date || null, visibility: projectDraft.visibility, color: projectDraft.color };
      if (projectDraft.id) {
        data.status = projectDraft.status;
        const r = await api.patch(`/tasks/projects/${projectDraft.id}`, data);
        setProjectDraft({ ...projectDraft, ...r.data });
      } else {
        const r = await api.post('/tasks/projects', { ...data, members: projectDraft.members.map(({ user_id, role }) => ({ user_id, role })) });
        setProjectDraft(null);
        setProjectId(r.data.id);
      }
    }, projectDraft.id ? 'Board updated' : 'Board created');
  }
  function logTime(task) { setTime(blankTime()); setError(''); setTimeTask(task); }
  function setFilter(setter, value) { setter(value); setPage(1); }
  const person = (personId) => people.find(p => p.user_id === personId);
  const personName = (personId) => personId === user?.id ? 'You' : person(personId)?.name ?? person(personId)?.email ?? (personId ? 'Workspace member' : 'Unassigned');
  // Avatars use real initials, including your own ("You" would read as "Y").
  const avatarName = (personId) => person(personId)?.name ?? (personId === user?.id ? user?.name : null) ?? person(personId)?.email ?? personName(personId);
  const sourceLink = detail?.source_app === 'hr' ? '/hr/employees' : detail?.source_type === 'deal' ? '/crm/deals' : '/crm/leads';
  const move = (taskId, status) => perform(() => api.patch(`/tasks/${taskId}`, { status }), `Moved to ${STATUSES[status]}`);
  const patchTask = (taskId, data) => perform(() => api.patch(`/tasks/${taskId}`, data));
  const stats = meta.stats ?? {};
  const editableBoards = projects.filter(p => p.can_edit && (p.status === 'active'));
  const newTask = (status = 'todo') => { setDetail(null); setError(''); setDraft({ ...blankTask(), status, project_id: currentBoard?.can_edit ? projectId : '', assignee_id: user.id }); };
  const canEditTasks = (task) => can('tasks.tasks.edit') && (!task.project_id || projects.find(p => p.id === task.project_id)?.can_edit !== false);

  // Who can be handed a task: on a private board, only its members (admins
  // see every board, so they count too); elsewhere anyone with task access.
  const assignable = useMemo(() => {
    const boardId = draft?.project_id;
    const board = projects.find(p => p.id === boardId);
    const everyone = people.filter(p => p.status === 'active' || !p.status);
    if (!board || board.visibility !== 'private') return everyone;
    const onBoard = new Set((board.members ?? []).map(m => m.user_id));
    return everyone.filter(p => onBoard.has(p.user_id));
  }, [draft?.project_id, projects, people]);

  const avatars = (members = [], max = 4) => <span className={styles.avatarStack}>{members.slice(0, max).map(m => <span key={m.user_id} className={styles.avatar} title={`${personName(m.user_id)} · ${ROLES[m.role] ?? m.role}`}>{initials(avatarName(m.user_id))}</span>)}{members.length > max && <span className={styles.avatarMore}>+{members.length - max}</span>}</span>;
  const visibilityBadge = (board) => <span className={styles.visibility}>{board.visibility === 'private' ? <><Lock size={10} />Private</> : <><Globe2 size={10} />Everyone</>}</span>;

  const taskCard = (task) => <article key={task.id} data-dragging={dragging === task.id} draggable={canEditTasks(task) && !busy}
    onDragStart={e => { e.dataTransfer.setData('text/plain', task.id); setDragging(task.id); }} onDragEnd={() => { setDragging(null); setDropTarget(null); }} className={styles.taskCard}>
    <div className={styles.cardEyebrow}><span className={`${styles.boardSwatch} flex items-center gap-1.5`} data-color={task.project_color}>{task.project_name && <span className={styles.boardDot} />}{task.project_name || (task.source_app ? `${task.source_app.toUpperCase()} follow-up` : 'Personal to-do')}</span><GripVertical size={14} aria-hidden="true" /></div>
    <button onClick={() => openTask(task.id)} className={styles.taskTitle}>{task.title}</button>
    {task.description && <p className={styles.cardDescription}>{task.description}</p>}
    <div className={styles.cardTags}><span className={styles.priority} data-priority={task.priority}><Flag size={10} />{task.priority}</span>{task.parent_id && <span className={styles.subtaskTag}>Subtask</span>}</div>
    <div className={styles.cardFooter}><span className={styles.due} data-overdue={Boolean(task.due_date && task.due_date < today() && task.status !== 'done')}><CalendarDays size={13} />{task.due_date ? new Date(`${task.due_date}T12:00:00`).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' }) : 'No due date'}</span><span className={styles.avatar} title={personName(task.assignee_id)}>{task.assignee_id ? initials(avatarName(task.assignee_id)) : '–'}</span></div>
    {can('tasks.time.log') && <button className="mt-3 flex items-center gap-2 text-sm" onClick={() => logTime(task)}><Timer size={14} />Log time</button>}
    {canEditTasks(task) && <select aria-label={`Status for ${task.title}`} className={styles.statusSelect} value={task.status} disabled={busy} onChange={e => move(task.id, e.target.value)}>{Object.entries(STATUSES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>}
  </article>;

  if (!active) return <div className={panel}><h1 className="text-xl font-semibold">Tasks & Boards</h1><p className="my-3">Add and install this app to start managing your team’s work.</p><Link href="/apps"><Button>Open marketplace</Button></Link></div>;
  if (!can(required)) return <Alert tone="critical">You do not have permission to view this page.</Alert>;
  return <div className={styles.workspace}>
    <header className={styles.hero}>
      <div className={styles.heroTop}><div className={styles.eyebrow}><span className={styles.appMark}><FolderKanban size={17} /></span>TASKS & BOARDS<span className={styles.heroDivider} />{manageAll ? 'ALL BOARDS' : 'YOUR BOARDS'}</div><span className={styles.liveLabel}><span /> {manageAll ? 'You can see every board in the workspace.' : 'You see the boards you have been added to.'}</span></div>
      <div className={styles.headingRow}><div><h1>{view === 'board' ? (currentBoard?.name ?? 'Every board, one view.') : view === 'work' ? 'Everything on your plate.' : view === 'projects' ? 'A board for every team.' : view === 'calendar' ? 'See what’s coming next.' : 'Time, well accounted for.'}</h1><p>{view === 'projects' ? 'Private boards are seen only by the people you add. Give each person or team exactly the board they need.' : 'Shared priorities. Clear ownership. Progress you can see.'}</p></div>
        <div className={styles.heroActions}>{can('tasks.projects.create') && <Button className={styles.secondaryAction} icon={FolderKanban} onClick={() => { setError(''); setProjectDraft(blankBoard()); }}>New board</Button>}{can('tasks.tasks.create') && <Button className={styles.primaryAction} icon={Plus} onClick={() => newTask()}>New task</Button>}</div>
      </div>
      <div className={styles.summary} aria-label="Workspace summary">
        {(view === 'projects' ? [[projects.filter(p => p.status === 'active').length, 'Active boards'], [projects.filter(p => p.visibility === 'private').length, 'Private boards'], [projects.reduce((n,p) => n + p.task_count, 0), 'Tasks'], [projects.reduce((n,p) => n + (p.overdue_count ?? 0), 0), 'Overdue']] : view === 'time' ? [[duration(meta.minutes), 'Time logged'], [meta.total ?? 0, 'Entries']] : [[stats.open ?? 0, 'Open tasks'], [stats.in_progress ?? 0, 'Working on it'], [stats.done ?? 0, 'Done'], [stats.overdue ?? 0, 'Overdue']]).map(([value, label]) => <div key={label}><strong>{loading && !meta.total && !projects.length ? '—' : value}</strong><span>{label}</span></div>)}
        <p>{['board', 'work', 'calendar'].includes(view) ? 'For the current filters' : view === 'time' ? 'For the selected board and people' : 'Boards you can see'}</p>
      </div>
    </header>
    <nav className={styles.tabs} aria-label="Task views">{VIEWS.filter(([key]) => can(key === 'projects' ? 'tasks.projects.view' : key === 'time' ? 'tasks.time.view' : 'tasks.tasks.view')).map(([key, url, label, Icon]) => <Link key={key} href={url} aria-current={key === view ? 'page' : undefined}><Icon size={16} />{label}</Link>)}</nav>
    {error && <Alert tone="critical">{error}</Alert>}

    {view === 'board' && projects.length > 0 && <div className={styles.boardPicker} aria-label="Boards">
      <a href="/tasks/board?all=1" aria-current={!projectId} onClick={e => { e.preventDefault(); setFilter(setProjectId, ''); }}>All my boards</a>
      {projects.filter(p => p.status !== 'archived').map(p => <a key={p.id} href={`/tasks/board?project=${p.id}`} className={styles.boardSwatch} data-color={p.color} aria-current={p.id === projectId} onClick={e => { e.preventDefault(); setFilter(setProjectId, p.id); }}><span className={styles.boardDot} />{p.name}</a>)}
    </div>}
    {view === 'board' && currentBoard && <div className={`${styles.boardHeader} ${styles.boardSwatch}`} data-color={currentBoard.color}>
      <span className={styles.boardDot} style={{ width: 14, height: 14 }} /><h2>{currentBoard.name}</h2>{visibilityBadge(currentBoard)}
      {currentBoard.my_role !== 'admin' && <span className="text-xs text-[var(--text-tertiary)]">You are {currentBoard.my_role === 'workspace' ? 'viewing an open board' : `an ${ROLES[currentBoard.my_role]?.toLowerCase() ?? currentBoard.my_role}`}</span>}
      <span className={styles.spacer} />
      {avatars(currentBoard.members)}
      <Button size="sm" icon={currentBoard.can_manage ? UserPlus : Users} onClick={() => openSharing(currentBoard)}>{currentBoard.can_manage ? 'Share' : 'Members'}</Button>
      {currentBoard.can_manage && <Button size="sm" variant="ghost" icon={Settings2} aria-label="Board settings" onClick={() => { setError(''); setProjectDraft({ ...blankBoard(), ...currentBoard, due_date: currentBoard.due_date ?? '' }); }} />}
      <span className={styles.viewToggle}>{[['kanban', 'Kanban', Kanban], ['table', 'Table', Table2]].map(([key, label, Icon]) => <button key={key} aria-pressed={layout === key} onClick={() => { setLayout(key); try { localStorage.setItem('nexus-board-layout', key); } catch { /* ignore */ } }}><Icon size={14} />{label}</button>)}</span>
    </div>}

    {view === 'work' && <p className="text-sm text-[var(--text-secondary)]">Your to-dos from every board you are on, plus personal ones. Use Log time after you work on something.</p>}
    {!['projects', 'time'].includes(view) && <div className={styles.toolbar}><div className={styles.search}><Search size={16} /><input aria-label="Search tasks" placeholder="Find a task…" value={search} onChange={e => setFilter(setSearch, e.target.value)} /></div><div className={styles.filters}><SlidersHorizontal size={15} aria-hidden="true" />{view !== 'board' && <select aria-label="Filter by board" value={projectId} onChange={e => setFilter(setProjectId, e.target.value)}><option value="">All boards</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}<label><input type="checkbox" checked={mine} onChange={e => setFilter(setMine, e.target.checked)} />Only mine</label>{view === 'calendar' && <input type="month" aria-label="Calendar month" value={month} onChange={e => { if (e.target.value) setFilter(setMonth, e.target.value); }} />}</div>{loading && <span className={styles.updating}>Updating…</span>}</div>}
    {loading && !tasks.length && !projects.length && !times.length ? <p className="py-12 text-center text-[var(--text-secondary)]">Loading your work…</p> : <>
      {view === 'projects' && <div className={styles.projectGrid}>{projects.map(p => <article className={`${styles.projectCard} ${styles.boardSwatch}`} data-color={p.color} key={p.id}>
        <div className={styles.projectTop}>{visibilityBadge(p)}<span className={styles.projectStatus} data-status={p.status}>{p.status[0].toUpperCase() + p.status.slice(1)}</span></div>
        <h2>{p.name}</h2><p className={styles.projectDescription}>{p.description || (p.visibility === 'private' ? 'Only the people on this board can see its tasks.' : 'Open to everyone in the workspace.')}</p>
        <div className="mt-4 flex items-center justify-between">{avatars(p.members)}<span className="text-xs text-[var(--text-tertiary)]">{p.members.length} member{p.members.length === 1 ? '' : 's'}</span></div>
        <div className={styles.progressHeading}><span>Progress</span><strong>{p.task_count ? Math.round(p.completed_count / p.task_count * 100) : 0}%</strong></div><div className={styles.progressTrack}><div style={{ width: `${p.task_count ? p.completed_count / p.task_count * 100 : 0}%`, background: 'var(--board)' }} /></div>
        <div className={styles.projectMeta}><span><CheckCircle2 size={13} />{p.completed_count}/{p.task_count} tasks</span>{p.overdue_count > 0 ? <span className="text-[#a55c56]"><AlertCircle size={13} />{p.overdue_count} overdue</span> : <span>{p.due_date || 'No deadline'}</span>}</div>
        {can('tasks.time.view') && <Link className="my-3 flex items-center gap-2 text-sm" href={`/tasks/time?project=${p.id}`}><Timer size={14} />{duration(p.logged_minutes)} logged</Link>}
        <div className={styles.projectActions}>{p.can_manage ? <button onClick={() => openSharing(p)} className="flex items-center gap-1.5"><UserPlus size={13} />Share</button> : <button onClick={() => openSharing(p)} className="flex items-center gap-1.5"><Users size={13} />Members</button>}<Link href={`/tasks/board?project=${p.id}`}>Open board <ArrowUpRight size={15} /></Link></div>
      </article>)}{!projects.length && <div className={styles.emptyState}><FolderKanban size={32} /><h2>{can('tasks.projects.create') ? 'Create your first board.' : 'No boards shared with you yet.'}</h2><p>{can('tasks.projects.create') ? 'A board per team, client or person — private to the people you add.' : 'When someone adds you to a board, it appears here. Personal to-dos live in My work.'}</p>{can('tasks.projects.create') && <Button icon={Plus} onClick={() => setProjectDraft(blankBoard())}>New board</Button>}</div>}</div>}

      {view === 'board' && layout === 'kanban' && <div className={styles.board}>{Object.entries(STATUSES).map(([status, label]) => <section key={status} className={styles.column} data-drop-target={dropTarget === status} onDragOver={e => { e.preventDefault(); if (dragging) setDropTarget(status); }} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setDropTarget(null); }} onDrop={e => { e.preventDefault(); const taskId = e.dataTransfer.getData('text/plain'); setDragging(null); setDropTarget(null); const dropped = tasks.find(t => t.id === taskId); if (!busy && dropped && canEditTasks(dropped) && dropped.status !== status) move(taskId, status); }}><div className={styles.columnHeading}><h2><span className={styles.statusDot} data-status={status} />{label}<span className={styles.columnCount}>{tasks.filter(t => t.status === status).length}</span></h2>{can('tasks.tasks.create') && (!currentBoard || currentBoard.can_edit) && <button aria-label={`Add task to ${label}`} onClick={() => newTask(status)}><Plus size={16} /></button>}</div><div className={styles.columnTasks}>{tasks.filter(t => t.status === status).map(taskCard)}{!tasks.some(t => t.status === status) && <div className={styles.emptyColumn}><Circle size={18} /><span>No tasks here yet</span><small>{status === 'done' ? 'Finished work finds its home here.' : 'Drop a task here to move it.'}</small></div>}</div></section>)}</div>}

      {view === 'board' && layout === 'table' && <div className={styles.groupScroll}>{Object.entries(STATUSES).map(([status, label]) => { const rows = tasks.filter(t => t.status === status); return <section key={status} className={styles.group} style={{ '--group': GROUP_COLORS[status] }}>
        <div className={styles.groupTitle}>{label}<small>{rows.length} item{rows.length === 1 ? '' : 's'}</small></div>
        <div className={styles.tableHead}><span>Task</span><span>Owner</span><span>Status</span><span>Priority</span><span>Due</span></div>
        {rows.map(task => <div key={task.id} className={styles.tableRow}>
          <button onClick={() => openTask(task.id)}>{task.status === 'done' ? <CheckCircle2 size={15} className="shrink-0 text-[#00c875]" /> : <Circle size={15} className="shrink-0 text-[var(--text-tertiary)]" />}<span className="truncate">{task.title}</span>{!currentBoard && task.project_name && <span className={`${styles.boardSwatch} ml-auto flex shrink-0 items-center gap-1 text-2xs font-normal text-[var(--text-tertiary)]`} data-color={task.project_color}><span className={styles.boardDot} />{task.project_name}</span>}</button>
          <span className="gap-2 text-xs"><span className={styles.avatar}>{task.assignee_id ? initials(avatarName(task.assignee_id)) : '–'}</span><span className="truncate">{task.assignee_id ? personName(task.assignee_id) : 'Unassigned'}</span></span>
          <span className={styles.pill} data-status={task.status}>{canEditTasks(task) ? <select aria-label={`Status for ${task.title}`} value={task.status} disabled={busy} onChange={e => move(task.id, e.target.value)}>{Object.entries(STATUSES).map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select> : STATUSES[task.status]}</span>
          <span className={styles.pill} data-priority={task.priority}>{canEditTasks(task) ? <select aria-label={`Priority for ${task.title}`} value={task.priority} disabled={busy} onChange={e => patchTask(task.id, { priority: e.target.value })}>{PRIORITIES.map(p => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}</select> : task.priority}</span>
          <span className={styles.due} data-overdue={Boolean(task.due_date && task.due_date < today() && task.status !== 'done')}>{canEditTasks(task) ? <input type="date" aria-label={`Due date for ${task.title}`} className="w-full bg-transparent text-xs outline-none" value={task.due_date ?? ''} disabled={busy} onChange={e => patchTask(task.id, { due_date: e.target.value || null })} /> : (task.due_date ?? '—')}</span>
        </div>)}
        {can('tasks.tasks.create') && currentBoard?.can_edit && currentBoard.status === 'active' && <form className={styles.addRow} onSubmit={e => { e.preventDefault(); const title = (quickAdd[status] ?? '').trim(); if (!title) return; perform(async () => { await api.post('/tasks', { title, status, project_id: currentBoard.id }); setQuickAdd(q => ({ ...q, [status]: '' })); }, 'Task added'); }}><Plus size={14} className="mt-1 text-[var(--text-tertiary)]" /><input aria-label={`Add a task to ${label}`} placeholder="+ Add task" value={quickAdd[status] ?? ''} onChange={e => setQuickAdd(q => ({ ...q, [status]: e.target.value }))} /></form>}
      </section>; })}</div>}

      {view === 'work' && (tasks.length ? <div className={styles.list}><div className={styles.listHeader}><span>Task</span><span>Status</span><span>Priority</span><span>Due date</span><span>Owner / time</span></div>{tasks.map(task => <div key={task.id} className={styles.listRow}><button onClick={() => openTask(task.id)} className={styles.listTitle}>{task.status === 'done' ? <CheckCircle2 size={18} /> : <Circle size={18} />}<span><strong>{task.title}</strong><small>{task.project_name || 'Personal to-do'}</small></span></button><span className={styles.listStatus}><span className={styles.statusDot} data-status={task.status} />{STATUSES[task.status]}</span><span><span className={styles.priority} data-priority={task.priority}>{task.priority}</span></span><span className={styles.due} data-overdue={Boolean(task.due_date && task.due_date < today() && task.status !== 'done')}>{task.due_date || '—'}</span><div><span className={styles.avatar} title={personName(task.assignee_id)}>{task.assignee_id ? initials(avatarName(task.assignee_id)) : '–'}</span>{can('tasks.time.log') && <button className="mt-2 text-xs underline" onClick={() => logTime(task)}>Log time</button>}</div></div>)}</div> : <div className={styles.emptyState}><ListChecks size={34} /><h2>A little breathing room.</h2><p>No tasks match this view. Adjust the filters or create something new.</p>{can('tasks.tasks.create') && <Button onClick={() => newTask()} icon={Plus}>Create a task</Button>}</div>)}
      {view === 'calendar' && <Calendar month={month} tasks={tasks} onOpen={openTask} />}
      {view === 'time' && <div className={panel}>
        <h2 className="text-lg font-semibold">Time you and your team recorded</h2>
        <p className="my-3 text-sm text-[var(--text-secondary)]">Time is entered manually after you work. Assigning a task or changing its status does not start a timer. Board time is the sum of entries on its tasks and subtasks, including archived tasks.</p>
        <div className="mb-5 flex flex-wrap items-center gap-4"><Select aria-label="Time board" value={projectId} onChange={e => setFilter(setProjectId,e.target.value)}><option value="">All boards</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</Select><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={mine} onChange={e => setFilter(setMine,e.target.checked)} />Only my entries</label><strong>{duration(meta.minutes)} total</strong><Link href="/tasks" className="text-sm underline">Go to My work to log time</Link></div>
        <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b"><th className="p-3">Date</th><th>Task / board</th><th>Person</th><th>Time spent</th><th>Note</th></tr></thead><tbody>{times.map(entry => <tr className="border-b border-[var(--border-default)]" key={entry.id}><td className="p-3">{entry.worked_on}</td><td><button className="text-[var(--text-brand)]" onClick={() => openTask(entry.task_id)}>{entry.title}</button><p className="text-xs text-[var(--text-secondary)]">{entry.project_name || 'Personal to-do'}</p></td><td>{personName(entry.user_id)}</td><td>{duration(entry.minutes)}</td><td>{entry.note}</td></tr>)}</tbody></table></div>{!times.length && <p className="py-8 text-center">No time logged here yet. Choose Log time on a task when you finish working on it.</p>}
      </div>}
      {view !== 'projects' && <div className="flex items-center justify-between text-sm text-[var(--text-secondary)]"><span>{meta.total ?? 0} records · Page {page}{view === 'calendar' ? ' · Tasks with a due date in this month' : ''}</span><div className="flex gap-2"><Button size="sm" icon={ArrowLeft} disabled={page === 1} onClick={() => setPage(p => p - 1)}>Previous</Button><Button size="sm" icon={ArrowRight} disabled={page * 100 >= (meta.total ?? 0)} onClick={() => setPage(p => p + 1)}>Next</Button></div></div>}
    </>}

    <Drawer className={styles.drawer} open={Boolean(draft)} onClose={() => { if (!busy) setDraft(null); }} title={draft?.id ? 'Edit task' : 'New task'}>
      {draft && <form onSubmit={saveTask} className={styles.editorForm}>{error && <Alert tone="critical">{error}</Alert>}
        <Label title="Title"><Input required data-autofocus placeholder="What needs to get done?" maxLength={200} value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })} /></Label>
        <Label title="Description"><Textarea rows={4} placeholder="Add context, a checklist or a useful detail…" value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })} /></Label>
        <Label title="Board"><Select value={draft.project_id ?? ''} onChange={e => setDraft({ ...draft, project_id: e.target.value, milestone_id: '' })}><option value="">No board — a personal to-do</option>{projects.filter(p => (p.can_edit && p.status === 'active') || p.id === draft.project_id).map(p => <option key={p.id} value={p.id}>{p.name}{p.visibility === 'private' ? ' (private)' : ''}</option>)}</Select></Label>
        {milestones.length > 0 && <Label title="Milestone"><Select value={draft.milestone_id ?? ''} onChange={e => setDraft({ ...draft, milestone_id: e.target.value })}><option value="">No milestone</option>{milestones.map(m => <option key={m.id} value={m.id}>{m.title}</option>)}</Select></Label>}
        <div className="grid grid-cols-2 gap-4"><Label title="Status"><Select value={draft.status} onChange={e => setDraft({ ...draft, status: e.target.value })}>{Object.entries(STATUSES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select></Label><Label title="Priority"><Select value={draft.priority} onChange={e => setDraft({ ...draft, priority: e.target.value })}>{PRIORITIES.map(p => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}</Select></Label></div>
        <Label title="Assignee"><Select value={draft.assignee_id ?? ''} onChange={e => setDraft({ ...draft, assignee_id: e.target.value })}><option value="">Unassigned</option><option value={user.id}>You</option>{can('tasks.tasks.assign') && assignable.filter(p => p.user_id !== user.id).map(p => <option key={p.user_id} value={p.user_id}>{p.name ?? p.email}</option>)}{draft.assignee_id && draft.assignee_id !== user.id && !assignable.some(p => p.user_id === draft.assignee_id) && <option value={draft.assignee_id}>{personName(draft.assignee_id)}</option>}</Select></Label>
        {projects.find(p => p.id === draft.project_id)?.visibility === 'private' && <p className="-mt-3 text-xs text-[var(--text-tertiary)]">Only people on this private board can be assigned. Share the board to add someone.</p>}
        <Label title="Due date"><Input type="date" value={draft.due_date ?? ''} onChange={e => setDraft({ ...draft, due_date: e.target.value })} /></Label>
        {draft.source_app && <p className="text-sm text-[var(--text-secondary)]">Linked to {draft.source_app.toUpperCase()} · {draft.source_type}</p>}
        <Button type="submit" variant="primary" loading={busy}>Save task</Button>
        {!draft.id && !editableBoards.length && !can('tasks.projects.create') && <p className="text-xs text-[var(--text-tertiary)]">You are not on any board you can edit, so this becomes a personal to-do.</p>}
      </form>}
    </Drawer>

    <Drawer className={styles.drawer} open={Boolean(detail) && !draft && !timeTask} onClose={() => { if (!busy) setDetail(null); }} title={detail?.title} subtitle={detail ? `${STATUSES[detail.status]} · ${detail.priority} priority` : ''}>
      {detail && <div className="space-y-6">{error && <Alert tone="critical">{error}</Alert>}
        <div className="flex flex-wrap gap-2">{canEditTasks(detail) && <Button onClick={() => { setDraft(detail); setDetail(null); }}>Edit task</Button>}{can('tasks.tasks.delete') && canEditTasks(detail) && <Button variant="danger-ghost" disabled={busy} onClick={() => perform(async () => { await api.del(`/tasks/${detail.id}`); setDetail(null); }, 'Task archived')}>Archive task</Button>}</div>
        <p className="whitespace-pre-wrap text-sm">{detail.description || 'No description yet.'}</p><div className="text-sm text-[var(--text-secondary)]">{projects.find(p => p.id === detail.project_id)?.name ?? 'Personal to-do'} · Assigned to {personName(detail.assignee_id)} · {detail.due_date ? `Due ${fmtDate(detail.due_date)}` : 'No deadline'}</div>
        {detail.source_app && <Link href={sourceLink} className="text-sm text-[var(--text-brand)]">Open linked {detail.source_app.toUpperCase()} {detail.source_type} list →</Link>}
        <section className="space-y-3"><h3 className="font-semibold">Subtasks</h3>{detail.subtasks.map(t => <button key={t.id} className="block text-sm text-[var(--text-brand)]" onClick={() => openTask(t.id)}>{t.status === 'done' ? '✓ ' : '○ '}{t.title}</button>)}{can('tasks.tasks.create') && canEditTasks(detail) && detail.status !== 'done' && <form className="flex gap-2" onSubmit={e => { e.preventDefault(); perform(async () => { await api.post('/tasks', { title: subtask, parent_id: detail.id }); setSubtask(''); await refreshDetail(); }); }}><Input required aria-label="Subtask title" placeholder="Add a subtask" value={subtask} onChange={e => setSubtask(e.target.value)} /><Button type="submit" loading={busy}>Add</Button></form>}</section>
        <section className="space-y-3"><h3 className="font-semibold">Updates</h3>{detail.comments.map(c => <div key={c.id} className="rounded-lg bg-[var(--surface-sunken)] p-3 text-sm"><p className="whitespace-pre-wrap">{c.body}</p><p className="mt-2 text-xs text-[var(--text-tertiary)]">{personName(c.created_by)} · {fmtDate(c.created_at, 'datetime')}</p></div>)}{can('tasks.tasks.edit') && <form onSubmit={e => { e.preventDefault(); perform(async () => { await api.post(`/tasks/${detail.id}/comments`, { body: comment }); setComment(''); await refreshDetail(); }, 'Update posted'); }} className="space-y-2"><Textarea required aria-label="Comment" placeholder="Write an update…" value={comment} onChange={e => setComment(e.target.value)} /><Button type="submit" loading={busy}>Post update</Button></form>}</section>
        {can('tasks.time.view') && <section className="space-y-2"><h3 className="font-semibold">Time on this task: {duration(detail.time_entries.reduce((sum, entry) => sum + entry.minutes, 0))}</h3>{detail.time_entries.map(t => <p key={t.id} className="text-sm">{t.worked_on} · {duration(t.minutes)} · {personName(t.user_id)} {t.note && `— ${t.note}`}</p>)}{!detail.time_entries.length && <p className="text-sm text-[var(--text-secondary)]">No time entries yet.</p>}</section>}
        {can('tasks.time.log') && <Button icon={Timer} onClick={() => logTime(detail)}>Log time on this task</Button>}
        <section className="space-y-3"><h3 className="flex items-center gap-2 font-semibold"><Paperclip size={16} />Documents</h3>{detail.attachments.map(a => <div key={a.id} className="flex items-center justify-between text-sm"><a className="text-[var(--text-brand)]" href={`${API_BASE}/api/documents/${a.document_id}/download`} target="_blank" rel="noreferrer">{a.name}</a>{canEditTasks(detail) && <Button size="xs" disabled={busy} onClick={() => perform(async () => { await api.del(`/tasks/${detail.id}/attachments/${a.id}`); await refreshDetail(); })}>Unlink</Button>}</div>)}{canEditTasks(detail) && can('documents.files.view') && <form className="flex gap-2" onSubmit={e => { e.preventDefault(); perform(async () => { await api.post(`/tasks/${detail.id}/attachments`, { document_id: documentId }); await refreshDetail(); }); }}><Select required aria-label="Document to attach" value={documentId} onChange={e => setDocumentId(e.target.value)}><option value="">Choose a workspace document</option>{documents.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</Select><Button type="submit" loading={busy}>Attach</Button></form>}<p className="text-xs text-[var(--text-secondary)]">Upload files in Documents, then link them here. Downloads retain Documents permissions.</p></section>
      </div>}
    </Drawer>

    <Drawer className={styles.drawer} open={Boolean(timeTask)} onClose={() => { if (!busy) setTimeTask(null); }} title="Log time" subtitle={timeTask?.title}>
      {timeTask && <form className="space-y-5" onSubmit={e => { e.preventDefault(); const minutes = Number(time.hours || 0) * 60 + Number(time.minutes || 0); if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) { setError('Enter time between 1 minute and 24 hours.'); return; } perform(async () => { await api.post(`/tasks/${timeTask.id}/time`, { minutes, worked_on: time.worked_on, note: time.note }); setTimeTask(null); setDetail(null); }, 'Time logged'); }}>
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

    <Drawer className={styles.drawer} open={Boolean(projectDraft)} onClose={() => { if (!busy) setProjectDraft(null); }} title={projectDraft?.id ? 'Board settings' : 'New board'} subtitle={projectDraft?.id ? projectDraft.name : 'A space for one team, client or person'}>
      {projectDraft && <div className="space-y-6">{error && <Alert tone="critical">{error}</Alert>}
        <form className="space-y-5" onSubmit={saveBoard}>
          <Label title="Board name"><Input required data-autofocus placeholder="e.g. Sales follow-ups, Priya’s to-dos" value={projectDraft.name} onChange={e => setProjectDraft({ ...projectDraft, name: e.target.value })} /></Label>
          <Label title="Description"><Textarea value={projectDraft.description} onChange={e => setProjectDraft({ ...projectDraft, description: e.target.value })} /></Label>
          <div className="space-y-1.5 text-sm"><span className="font-medium">Colour</span><div className={styles.swatches}>{COLORS.map(c => <button key={c} type="button" className={styles.boardSwatch} data-color={c} aria-label={c} aria-pressed={projectDraft.color === c} onClick={() => setProjectDraft({ ...projectDraft, color: c })} />)}</div></div>
          <div className="space-y-2 text-sm"><span className="font-medium">Who can see it</span>
            {[['private', Lock, 'Private', 'Only the people you add. Admins can always see it.'], ['workspace', Globe2, 'Everyone in the workspace', 'Anyone with Tasks access can see it and, if they can edit tasks, work on it.']].map(([value, Icon, title, hint]) => <label key={value} className={styles.choice} data-selected={projectDraft.visibility === value}><input type="radio" name="visibility" className="sr-only" checked={projectDraft.visibility === value} onChange={() => setProjectDraft({ ...projectDraft, visibility: value })} /><Icon size={16} className="mt-0.5 shrink-0" /><span><strong>{title}</strong><small>{hint}</small></span></label>)}
          </div>
          {!projectDraft.id && can('core.members.view') && <div className="space-y-2 text-sm"><span className="font-medium">Add people now (optional)</span>
            {projectDraft.members.map(m => <div key={m.user_id} className={styles.memberRow}><span className={styles.avatar}>{initials(avatarName(m.user_id))}</span><div><strong>{personName(m.user_id)}</strong></div><Select aria-label="Board role" value={m.role} onChange={e => setProjectDraft({ ...projectDraft, members: projectDraft.members.map(x => x.user_id === m.user_id ? { ...x, role: e.target.value } : x) })}><option value="editor">Editor</option><option value="viewer">Viewer</option><option value="owner">Owner</option></Select><Button type="button" size="xs" variant="ghost" icon={Trash2} aria-label="Remove" onClick={() => setProjectDraft({ ...projectDraft, members: projectDraft.members.filter(x => x.user_id !== m.user_id) })} /></div>)}
            <Select aria-label="Add a person" value="" onChange={e => e.target.value && setProjectDraft({ ...projectDraft, members: [...projectDraft.members, { user_id: e.target.value, role: 'editor' }] })}><option value="">Choose a person…</option>{people.filter(p => p.user_id !== user.id && (p.status === 'active' || !p.status) && !projectDraft.members.some(m => m.user_id === p.user_id)).map(p => <option key={p.user_id} value={p.user_id}>{p.name ?? p.email}</option>)}</Select>
          </div>}
          <Label title="Deadline (optional)"><Input type="date" value={projectDraft.due_date ?? ''} onChange={e => setProjectDraft({ ...projectDraft, due_date: e.target.value })} /></Label>
          {projectDraft.id && <Label title="Status"><Select value={projectDraft.status} onChange={e => setProjectDraft({ ...projectDraft, status: e.target.value })}>{['active', 'completed', 'archived'].map(s => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}</Select></Label>}
          <Button type="submit" variant="primary" loading={busy}>{projectDraft.id ? 'Save board' : 'Create board'}</Button>
        </form>
        {projectDraft.id && <section className="space-y-3"><h3 className="font-semibold">Milestones</h3>{projectMilestones.map(m => <label key={m.id} className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={busy} checked={m.completed} onChange={e => perform(async () => { await api.patch(`/tasks/milestones/${m.id}`, { completed: e.target.checked }); setProjectMilestones((await api.get(`/tasks/projects/${projectDraft.id}/milestones`)).data); })} />{m.title} {m.due_date && `· ${m.due_date}`}</label>)}{projectDraft.status === 'active' && <form className="space-y-3" onSubmit={e => { e.preventDefault(); perform(async () => { await api.post(`/tasks/projects/${projectDraft.id}/milestones`, { title: milestone.title, due_date: milestone.due_date || null }); setMilestone({ title: '', due_date: '' }); setProjectMilestones((await api.get(`/tasks/projects/${projectDraft.id}/milestones`)).data); }); }}><Label title="Milestone title"><Input required value={milestone.title} onChange={e => setMilestone({ ...milestone, title: e.target.value })} /></Label><Label title="Milestone deadline"><Input type="date" value={milestone.due_date} onChange={e => setMilestone({ ...milestone, due_date: e.target.value })} /></Label><Button type="submit" loading={busy}>Add milestone</Button></form>}</section>}
      </div>}
    </Drawer>

    <Drawer className={styles.drawer} open={Boolean(sharing)} onClose={() => { if (!busy) setSharing(null); }} title={sharing?.can_manage ? 'Share board' : 'Board members'} subtitle={sharing?.name}>
      {sharing && <div className="space-y-5">{error && <Alert tone="critical">{error}</Alert>}
        <p className="text-sm text-[var(--text-secondary)]">{sharing.visibility === 'private' ? 'This board is private. Only the people below can see its tasks — and admins, who can see every board.' : 'Everyone in the workspace can see this board. People below have a role on it.'}</p>
        <div>{sharing.members.map(m => <div key={m.user_id} className={styles.memberRow}><span className={styles.avatar}>{initials(avatarName(m.user_id))}</span><div><strong>{personName(m.user_id)}{m.user_id === user.id ? ' (you)' : ''}</strong><small>{person(m.user_id)?.email ?? ''}</small></div>
          {sharing.can_manage ? <Select aria-label={`Role for ${personName(m.user_id)}`} value={m.role} disabled={busy} onChange={e => perform(async () => { await api.put(`/tasks/projects/${sharing.id}/members/${m.user_id}`, { role: e.target.value }); await refreshSharing(); }, 'Role updated')}>{Object.entries(ROLES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select> : <span className="text-xs text-[var(--text-secondary)]">{ROLES[m.role]}</span>}
          {(sharing.can_manage || m.user_id === user.id) && <Button size="xs" variant="ghost" icon={Trash2} aria-label={m.user_id === user.id ? 'Leave board' : `Remove ${personName(m.user_id)}`} disabled={busy} onClick={() => perform(async () => { await api.del(`/tasks/projects/${sharing.id}/members/${m.user_id}`); if (m.user_id === user.id && !manageAll) setSharing(null); else await refreshSharing(); }, m.user_id === user.id ? 'You left the board' : 'Removed from board')} />}
        </div>)}</div>
        {sharing.can_manage && (can('core.members.view') ? <form className="space-y-3" onSubmit={e => { e.preventDefault(); if (!invitee.user_id) return; perform(async () => { await api.put(`/tasks/projects/${sharing.id}/members/${invitee.user_id}`, { role: invitee.role }); setInvitee({ user_id: '', role: 'editor' }); await refreshSharing(); }, 'Added to board'); }}>
          <h3 className="text-sm font-semibold">Add someone</h3>
          <div className="flex gap-2"><Select aria-label="Person" value={invitee.user_id} onChange={e => setInvitee({ ...invitee, user_id: e.target.value })}><option value="">Choose a workspace member…</option>{people.filter(p => (p.status === 'active' || !p.status) && !sharing.members.some(m => m.user_id === p.user_id)).map(p => <option key={p.user_id} value={p.user_id}>{p.name ?? p.email}</option>)}</Select><Select aria-label="Role" value={invitee.role} onChange={e => setInvitee({ ...invitee, role: e.target.value })}><option value="editor">Editor</option><option value="viewer">Viewer</option><option value="owner">Owner</option></Select></div>
          <Button type="submit" variant="primary" icon={UserPlus} loading={busy} disabled={!invitee.user_id}>Add to board</Button>
          <p className="text-xs text-[var(--text-tertiary)]">Not in the list? <Link className="underline" href="/settings/members">Invite them to the workspace</Link> first — they can join from the email link.</p>
        </form> : <p className="text-xs text-[var(--text-tertiary)]">Ask a workspace admin to add people who are not listed yet.</p>)}
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
