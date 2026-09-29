'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Plus, Search, BookOpen, FolderOpen, ArrowLeft, Pencil, Globe, Archive, Undo2, Trash2, Eye, Save, FolderPlus,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { relativeTime, date, pluralize } from '@/lib/format';
import { Can, useWorkspace } from '@/lib/workspace';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Field, Select, Textarea } from '@/components/ui/input';
import { Modal, ConfirmModal } from '@/components/ui/modal';
import { Markdown } from '@/components/data/markdown';
import { Badge, Card, EmptyState, PageHeader, Alert, Skeleton } from '@/components/ui/primitives';

const STATUS_TONE = { draft: 'caution', published: 'positive', archived: 'neutral' };

/**
 * The team's answers, written once. Agents link articles in ticket replies;
 * new joiners read them instead of asking. Drafts are only visible to people
 * who can edit, and going live is its own permission.
 */
export default function KnowledgeClient() {
  const router = useRouter();
  const params = useSearchParams();
  const articleId = params.get('article');
  const creating = params.get('new') === '1';
  const [categories, setCategories] = useState([]);

  const loadCategories = useCallback(() => {
    api.get('/knowledge/categories').then((r) => setCategories(r.data)).catch(() => {});
  }, []);
  useEffect(() => { loadCategories(); }, [loadCategories]);

  const go = (query) => router.push(query ? `/knowledge?${query}` : '/knowledge');

  if (creating) return <Editor categories={categories} onDone={(id) => go(id ? `article=${id}` : '')} />;
  if (articleId) return <Reader articleId={articleId} categories={categories} onBack={() => go('')} onChanged={loadCategories} />;
  return <Library categories={categories} onOpen={(id) => go(`article=${id}`)} onNew={() => go('new=1')} onCategoriesChanged={loadCategories} />;
}

/* ── library ──────────────────────────────────────────────────────────────── */

function Library({ categories, onOpen, onNew, onCategoriesChanged }) {
  const { can } = useWorkspace();
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [articles, setArticles] = useState(null);
  const [error, setError] = useState(null);
  const [addingCategory, setAddingCategory] = useState(false);
  const drafts = can('knowledge.articles.edit') || can('knowledge.articles.publish');

  useEffect(() => {
    const timer = setTimeout(() => {
      api.get('/knowledge/articles', { query: { category_id: category || undefined, status: status || undefined, q: search || undefined, limit: 50 } })
        .then((r) => { setArticles(r.data); setError(null); })
        .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load articles.'));
    }, search ? 250 : 0);
    return () => clearTimeout(timer);
  }, [category, status, search]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Knowledge Base"
        description="Answers your team gives every day — visa checklists, fee structures, processes — written once and found in seconds."
        actions={<Can permission="knowledge.articles.create"><Button variant="primary" icon={Plus} onClick={onNew}>New article</Button></Can>}
      />

      <div className="grid gap-6 lg:grid-cols-[14rem_1fr]">
        <nav className="space-y-1 text-sm">
          <CategoryLink active={!category} onClick={() => setCategory('')} icon={BookOpen} label="All articles" />
          {categories.map((c) => (
            <CategoryLink key={c.id} active={category === c.id} onClick={() => setCategory(c.id)} icon={FolderOpen} label={c.name} count={c.article_count} />
          ))}
          <Can permission="knowledge.spaces.manage">
            <button onClick={() => setAddingCategory(true)} className="flex w-full items-center gap-2 rounded-[var(--radius-md)] px-2.5 py-1.5 text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]">
              <FolderPlus className="size-4" /> New category
            </button>
          </Can>
        </nav>

        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Input icon={Search} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search titles and text…" className="w-full max-w-md" />
            {drafts && (
              <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-auto" aria-label="Status">
                <option value="">Live and drafts</option>
                <option value="published">Published</option>
                <option value="draft">Drafts</option>
                <option value="archived">Archived</option>
              </Select>
            )}
          </div>

          {error && <Alert tone="critical">{error}</Alert>}
          {!articles ? (
            <div className="space-y-3"><Skeleton className="h-20" /><Skeleton className="h-20" /><Skeleton className="h-20" /></div>
          ) : articles.length === 0 ? (
            <Card>
              <EmptyState
                icon={BookOpen}
                title={search ? `Nothing matches “${search}”` : 'No articles here yet'}
                description={search ? 'Try a shorter word — search matches the start of words.' : 'Start with the question your team answers most often.'}
                action={can('knowledge.articles.create') && !search && <Button variant="primary" icon={Plus} onClick={onNew}>Write an article</Button>}
              />
            </Card>
          ) : (
            <ul className="space-y-2">
              {articles.map((a) => (
                <li key={a.id}>
                  <button onClick={() => onOpen(a.id)} className="panel block w-full p-4 text-left transition hover:border-[var(--border-strong)]">
                    <div className="flex items-start gap-2">
                      <p className="min-w-0 flex-1 font-medium">{a.title}</p>
                      {a.status !== 'published' && <Badge size="sm" tone={STATUS_TONE[a.status]}>{a.status}</Badge>}
                    </div>
                    {a.excerpt && <p className="mt-1 line-clamp-2 text-sm text-[var(--text-secondary)]">{a.excerpt}</p>}
                    <p className="mt-2 flex flex-wrap gap-x-3 text-xs text-[var(--text-tertiary)]">
                      {a.category_name && <span>{a.category_name}</span>}
                      <span>Updated {relativeTime(a.updated_at)}</span>
                      {a.status === 'published' && <span className="inline-flex items-center gap-1"><Eye className="size-3" />{a.views}</span>}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {addingCategory && <CategoryModal onClose={() => setAddingCategory(false)} onSaved={onCategoriesChanged} />}
    </div>
  );
}

function CategoryLink({ active, onClick, icon: Icon, label, count }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-[var(--radius-md)] px-2.5 py-1.5 text-left',
        active ? 'bg-[var(--surface-active)] font-medium text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]',
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined && <span className="tabular text-xs text-[var(--text-tertiary)]">{count}</span>}
    </button>
  );
}

function CategoryModal({ onClose, onSaved }) {
  const [name, setName] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event?.preventDefault();
    setBusy(true);
    try {
      await api.post('/knowledge/categories', { name });
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add the category.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="New category" size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!name.trim()} onClick={submit}>Add</Button></>}
    >
      <form onSubmit={submit} className="space-y-3">
        {error && <Alert tone="critical">{error}</Alert>}
        <Field label="Name">{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} placeholder="Visa & travel" data-autofocus />}</Field>
      </form>
    </Modal>
  );
}

/* ── reader ───────────────────────────────────────────────────────────────── */

function Reader({ articleId, categories, onBack, onChanged }) {
  const toast = useToast();
  const [article, setArticle] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    try {
      setArticle((await api.get(`/knowledge/articles/${articleId}`)).data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not open that article.');
    }
  }, [articleId]);
  useEffect(() => { load(); }, [load]);

  async function setStatus(status, message) {
    try {
      setArticle((await api.post(`/knowledge/articles/${articleId}/status`, { status })).data);
      toast.success(message);
      onChanged();
    } catch (err) {
      toast.error('Could not change the status', { description: err instanceof ApiError ? err.message : undefined });
    }
  }

  async function remove() {
    try {
      await api.del(`/knowledge/articles/${articleId}`);
      toast.success('Article deleted');
      onChanged();
      onBack();
    } catch (err) {
      toast.error('Could not delete', { description: err instanceof ApiError ? err.message : undefined });
    }
  }

  if (error) return <div className="space-y-4"><Button variant="ghost" size="sm" icon={ArrowLeft} onClick={onBack}>Knowledge Base</Button><Alert tone="critical">{error}</Alert></div>;
  if (!article) return <Skeleton className="h-64 w-full" />;
  if (editing) return <Editor article={article} categories={categories} onDone={() => { setEditing(false); load(); onChanged(); }} />;

  const a = article;
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={onBack}>Knowledge Base</Button>
        <div className="flex-1" />
        <Can permission="knowledge.articles.edit"><Button size="sm" variant="secondary" icon={Pencil} onClick={() => setEditing(true)}>Edit</Button></Can>
        <Can permission="knowledge.articles.publish">
          {a.status === 'draft' && <Button size="sm" variant="primary" icon={Globe} onClick={() => setStatus('published', 'Published')}>Publish</Button>}
          {a.status === 'published' && <Button size="sm" variant="ghost" icon={Undo2} onClick={() => setStatus('draft', 'Moved back to draft')}>Unpublish</Button>}
          {a.status !== 'archived' && <Button size="sm" variant="ghost" icon={Archive} onClick={() => setStatus('archived', 'Archived')}>Archive</Button>}
          {a.status === 'archived' && <Button size="sm" variant="ghost" icon={Undo2} onClick={() => setStatus('draft', 'Restored as a draft')}>Restore</Button>}
        </Can>
        <Can permission="knowledge.articles.delete"><Button size="sm" variant="danger-ghost" icon={Trash2} onClick={() => setDeleting(true)} aria-label="Delete" /></Can>
      </div>

      <article className="panel p-6 sm:p-8">
        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-[var(--text-tertiary)]">
          {a.category_name && <span>{a.category_name}</span>}
          {a.status !== 'published' && <Badge size="sm" tone={STATUS_TONE[a.status]}>{a.status}</Badge>}
        </div>
        <h1 className="text-2xl font-semibold tracking-[-0.025em]">{a.title}</h1>
        <p className="mt-1 text-xs text-[var(--text-tertiary)]">
          {a.published_at ? `Published ${date(a.published_at)} · ` : ''}Updated {relativeTime(a.updated_at)}{a.status === 'published' ? ` · ${pluralize(a.views, 'view')}` : ''}
        </p>
        {a.tags?.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">{a.tags.map((t) => <Badge key={t} size="sm">{t}</Badge>)}</div>
        )}
        <div className="mt-6">{a.body ? <Markdown>{a.body}</Markdown> : <p className="text-[var(--text-tertiary)]">This article is empty.</p>}</div>
      </article>

      <ConfirmModal open={deleting} onClose={() => setDeleting(false)} onConfirm={remove} danger title="Delete this article?" description="Archiving keeps it out of sight without losing it." confirmLabel="Delete" />
    </div>
  );
}

/* ── editor ───────────────────────────────────────────────────────────────── */

function Editor({ article, categories, onDone }) {
  const toast = useToast();
  const { can } = useWorkspace();
  const isNew = !article;
  const [form, setForm] = useState({
    title: article?.title ?? '', body: article?.body ?? '', category_id: article?.category_id ?? '',
    tags: (article?.tags ?? []).join(', '),
  });
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function save(publish = false) {
    setBusy(true);
    setError(null);
    const payload = {
      title: form.title, body: form.body, category_id: form.category_id || null,
      tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 20),
    };
    try {
      const saved = isNew
        ? (await api.post('/knowledge/articles', payload)).data
        : (await api.patch(`/knowledge/articles/${article.id}`, payload)).data;
      if (publish) await api.post(`/knowledge/articles/${saved.id}/status`, { status: 'published' });
      toast.success(publish ? 'Published' : isNew ? 'Draft saved' : 'Saved');
      onDone(saved.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={() => onDone(article?.id)}>{isNew ? 'Cancel' : 'Back to article'}</Button>
        <div className="flex-1" />
        <Button size="sm" variant="ghost" icon={preview ? Pencil : Eye} onClick={() => setPreview((v) => !v)}>{preview ? 'Write' : 'Preview'}</Button>
        <Button size="sm" variant="secondary" icon={Save} loading={busy} disabled={!form.title.trim()} onClick={() => save(false)}>{isNew ? 'Save draft' : 'Save'}</Button>
        {can('knowledge.articles.publish') && (isNew || article.status !== 'published') && (
          <Button size="sm" variant="primary" icon={Globe} loading={busy} disabled={!form.title.trim() || !form.body.trim()} onClick={() => save(true)}>Save & publish</Button>
        )}
      </div>
      {error && <Alert tone="critical">{error}</Alert>}
      <div className="panel space-y-4 p-6">
        <input
          value={form.title}
          onChange={set('title')}
          placeholder="Article title"
          className="w-full bg-transparent text-2xl font-semibold tracking-[-0.025em] outline-none placeholder:text-[var(--text-disabled)]"
          aria-label="Title"
          autoFocus={isNew}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <Select value={form.category_id} onChange={set('category_id')} aria-label="Category">
            <option value="">No category</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Input value={form.tags} onChange={set('tags')} placeholder="Tags, separated by commas" aria-label="Tags" />
        </div>
        {preview ? (
          <div className="min-h-[20rem] border-t border-[var(--border-subtle)] pt-4">{form.body ? <Markdown>{form.body}</Markdown> : <p className="text-[var(--text-tertiary)]">Nothing to preview yet.</p>}</div>
        ) : (
          <Textarea
            value={form.body}
            onChange={set('body')}
            rows={20}
            placeholder={'Write in plain text or Markdown.\n\n## Documents needed\n- Passport (valid 6+ months)\n- **Blocked account** confirmation'}
            className="font-mono text-sm"
            aria-label="Article body"
          />
        )}
      </div>
    </div>
  );
}
