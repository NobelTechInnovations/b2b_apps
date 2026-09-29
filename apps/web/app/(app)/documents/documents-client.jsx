'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Upload, FolderPlus, FolderOpen, FileSpreadsheet, FileText, FileImage, File,
  FileArchive, Download, Trash2, Table2, HardDrive, Search, ArrowRight, History,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { relativeTime, date } from '@/lib/format';
import { Can, useWorkspace } from '@/lib/workspace';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Field } from '@/components/ui/input';
import { Modal, ConfirmModal } from '@/components/ui/modal';
import { Drawer, DetailGrid } from '@/components/data/drawer';
import { ListToolbar } from '@/components/data/list-shell';
import { Card, EmptyState, PageHeader, Badge, Alert, Skeleton } from '@/components/ui/primitives';
import { ImportWizard } from './import-wizard';
import { API_BASE } from '@/lib/api-base';

const KIND = {
  spreadsheet: { icon: FileSpreadsheet, tint: 'bg-[#ecfdf5] text-[#059669] dark:bg-[rgb(16_185_129/0.14)] dark:text-[#6ee7b7]' },
  pdf:         { icon: FileText,        tint: 'bg-[#fff1f2] text-[#e11d48] dark:bg-[rgb(244_63_94/0.14)] dark:text-[#fda4af]' },
  document:    { icon: FileText,        tint: 'bg-[#eff6ff] text-[#2563eb] dark:bg-[rgb(59_130_246/0.14)] dark:text-[#93c5fd]' },
  image:       { icon: FileImage,       tint: 'bg-[#faf5ff] text-[#9333ea] dark:bg-[rgb(168_85_247/0.14)] dark:text-[#d8b4fe]' },
  archive:     { icon: FileArchive,     tint: 'bg-[#fffbeb] text-[#d97706] dark:bg-[rgb(245_158_11/0.14)] dark:text-[#fcd34d]' },
  file:        { icon: File,            tint: 'bg-[var(--surface-sunken)] text-[var(--text-secondary)]' },
};

const humanSize = (bytes) => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes ?? 0);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
};

export default function DocumentsClient() {
  const toast = useToast();
  const { can } = useWorkspace();
  const fileInput = useRef(null);

  const [documents, setDocuments] = useState([]);
  const [folders, setFolders] = useState([]);
  const [storage, setStorage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [search, setSearch] = useState('');
  const [folderId, setFolderId] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [importing, setImporting] = useState(null);
  const [deleting, setDeleting] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [docs, folderList] = await Promise.all([
        api.get('/documents', {
          query: { q: search || undefined, folder_id: folderId ?? undefined, root: folderId ? undefined : true, limit: 100 },
        }),
        api.get('/documents/folders'),
      ]);
      setDocuments(docs.data);
      setStorage(docs.meta?.storage ?? null);
      setFolders(folderList.data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load your documents.');
    } finally {
      setLoading(false);
    }
  }, [search, folderId]);

  useEffect(() => {
    const timer = setTimeout(load, search ? 280 : 0);
    return () => clearTimeout(timer);
  }, [load, search]);

  async function uploadFiles(fileList) {
    const files = [...fileList];
    if (!files.length) return;

    setUploading(true);
    let succeeded = 0;

    for (const file of files) {
      const form = new FormData();
      form.append('file', file);
      if (folderId) form.append('folder_id', folderId);

      try {
        const response = await fetch(
          `${API_BASE}/api/documents/upload`,
          { method: 'POST', credentials: 'include', body: form },
        );
        const payload = await response.json();

        if (!response.ok) {
          toast.error(`${file.name} was not uploaded`, {
            description: payload?.error?.message ?? 'Please try again.',
          });
          continue;
        }

        succeeded += 1;
        if (payload.data?.importable) {
          toast.success(`${file.name} uploaded`, {
            description: `${payload.data.sheets} sheet(s) found — you can import this into CRM or HR.`,
          });
        } else if (payload.data?.deduplicated) {
          toast.success(`${file.name} uploaded`, { description: 'Identical content already stored — no extra space used.' });
        } else {
          toast.success(`${file.name} uploaded`);
        }
      } catch {
        toast.error(`${file.name} could not be uploaded`);
      }
    }

    setUploading(false);
    if (succeeded) load();
  }

  async function remove() {
    try {
      await api.del(`/documents/${deleting.id}`);
      toast.success(`${deleting.name} removed`, { description: 'Recoverable for 30 days.' });
      setDeleting(null);
      load();
    } catch (err) {
      toast.error('Could not remove that file', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    }
  }

  const currentFolder = folders.find((f) => f.id === folderId);

  return (
    <div
      className="space-y-5"
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (can('documents.files.upload')) uploadFiles(e.dataTransfer.files);
      }}
    >
      <PageHeader
        title="Documents"
        description="One place for every file — and the bridge from a spreadsheet into your other apps."
        breadcrumb={
          currentFolder && (
            <button onClick={() => setFolderId(null)} className="hover:text-[var(--text-primary)]">
              All files
            </button>
          )
        }
        actions={
          <div className="flex gap-2">
            <Can permission="documents.folders.manage">
              <Button variant="secondary" icon={FolderPlus} onClick={() => setCreatingFolder(true)}>
                New folder
              </Button>
            </Can>
            <Can permission="documents.files.upload">
              <Button variant="primary" icon={Upload} loading={uploading}
                onClick={() => fileInput.current?.click()}>
                Upload
              </Button>
            </Can>
          </div>
        }
      />

      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(e) => { uploadFiles(e.target.files); e.target.value = ''; }}
      />

      {storage && (
        <Card className="flex flex-wrap items-center gap-4 p-4">
          <span className="flex size-9 items-center justify-center rounded-[var(--radius-lg)] bg-[var(--surface-sunken)] text-[var(--text-secondary)]">
            <HardDrive className="size-4" />
          </span>
          <div className="min-w-[10rem] flex-1">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm text-[var(--text-secondary)]">Storage used</span>
              <span className="text-sm font-medium tabular">
                {humanSize(storage.used)} <span className="text-[var(--text-tertiary)]">of {humanSize(storage.limit)}</span>
              </span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-[var(--surface-sunken)]">
              <div
                className={cn('h-full rounded-full transition-all duration-700',
                  storage.percent > 85 ? 'bg-[var(--color-critical-500)]'
                  : storage.percent > 60 ? 'bg-[var(--color-caution-500)]'
                  : 'bg-gradient-to-r from-[var(--color-brand-500)] to-[var(--color-brand-400)]')}
                style={{ width: `${Math.max(storage.percent, storage.used > 0 ? 2 : 0)}%` }}
              />
            </div>
          </div>
          <span className="text-xs text-[var(--text-tertiary)]">
            {storage.blobs} unique file{storage.blobs === 1 ? '' : 's'} stored
          </span>
        </Card>
      )}

      <ListToolbar
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Search files…"
      />

      {error && <Alert tone="critical">{error}</Alert>}

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-[rgb(79_70_229/0.08)] backdrop-blur-[1px]">
          <div className="panel flex items-center gap-3 px-6 py-4 shadow-[var(--shadow-xl)]">
            <Upload className="size-5 text-[var(--color-brand-600)]" />
            <span className="text-md font-medium">Drop to upload</span>
          </div>
        </div>
      )}

      {/* ── folders ──────────────────────────────────────────────────────── */}
      {!search && folders.length > 0 && (
        <div>
          <h2 className="mb-2.5 text-sm font-medium text-[var(--text-secondary)]">Folders</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {folders.map((folder) => (
              <button
                key={folder.id}
                onClick={() => setFolderId(folder.id === folderId ? null : folder.id)}
                className={cn(
                  'panel panel-hover flex items-center gap-3 p-3.5 text-left',
                  folderId === folder.id && 'border-[var(--color-brand-500)]',
                )}
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-lg)] bg-[#fffbeb] text-[#d97706] dark:bg-[rgb(245_158_11/0.14)] dark:text-[#fcd34d]">
                  <FolderOpen className="size-4" />
                </span>
                <div className="min-w-0">
                  <p className="truncate text-base font-medium">{folder.name}</p>
                  <p className="truncate text-xs text-[var(--text-tertiary)]">
                    {folder.document_count} file{folder.document_count === 1 ? '' : 's'} · {folder.size_label}
                  </p>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── files ────────────────────────────────────────────────────────── */}
      {loading ? (
        <div className="space-y-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
      ) : documents.length === 0 ? (
        <Card>
          <EmptyState
            icon={Upload}
            title={search ? 'No files match' : currentFolder ? `${currentFolder.name} is empty` : 'No files yet'}
            description={
              search
                ? 'Try a different search.'
                : 'Drag a file anywhere on this page, or upload a spreadsheet to import it into CRM or HR.'
            }
            action={
              can('documents.files.upload') && (
                <Button variant="primary" icon={Upload} onClick={() => fileInput.current?.click()}>
                  Upload a file
                </Button>
              )
            }
          />
        </Card>
      ) : (
        <div className="space-y-2">
          {documents.map((document) => {
            const meta = KIND[document.kind] ?? KIND.file;
            return (
              <div key={document.id} className="panel panel-hover flex flex-wrap items-center gap-3 p-3.5">
                <button
                  onClick={() => setSelectedId(document.id)}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                >
                  <span className={cn('flex size-10 shrink-0 items-center justify-center rounded-[var(--radius-lg)]', meta.tint)}>
                    <meta.icon className="size-5" strokeWidth={1.75} />
                  </span>
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 truncate text-base font-medium">
                      {document.name}
                      {document.current_version > 1 && (
                        <Badge size="sm" tone="neutral">v{document.current_version}</Badge>
                      )}
                    </p>
                    <p className="truncate text-xs text-[var(--text-tertiary)]">
                      {document.size_label} · {relativeTime(document.created_at)}
                      {document.folder_name ? ` · ${document.folder_name}` : ''}
                      {document.sheet_count > 0 ? ` · ${document.sheet_count} sheet${document.sheet_count === 1 ? '' : 's'}` : ''}
                    </p>
                  </div>
                </button>

                <div className="flex items-center gap-1">
                  {document.importable && (
                    <Button
                      variant="primary"
                      size="sm"
                      icon={Table2}
                      iconRight={ArrowRight}
                      onClick={() => setImporting(document)}
                    >
                      Import
                    </Button>
                  )}
                  <a
                    href={`${API_BASE}/api/documents/${document.id}/download`}
                  >
                    <Button variant="ghost" size="icon-sm" aria-label={`Download ${document.name}`}>
                      <Download className="size-4" />
                    </Button>
                  </a>
                  <Can permission="documents.files.delete">
                    <Button variant="ghost" size="icon-sm" aria-label={`Delete ${document.name}`}
                      onClick={() => setDeleting(document)}>
                      <Trash2 className="size-4" />
                    </Button>
                  </Can>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <DocumentDrawer documentId={selectedId} onClose={() => setSelectedId(null)}
        onImport={(doc) => { setSelectedId(null); setImporting(doc); }} />

      <NewFolderModal open={creatingFolder} onClose={() => setCreatingFolder(false)} onCreated={load} />

      <ConfirmModal
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={remove}
        danger
        confirmLabel="Delete"
        title={`Delete ${deleting?.name}?`}
        description="The file is archived and recoverable for 30 days."
      />

      {importing && (
        <ImportWizard
          document={importing}
          onClose={() => setImporting(null)}
          onImported={() => { setImporting(null); load(); }}
        />
      )}
    </div>
  );
}

function DocumentDrawer({ documentId, onClose, onImport }) {
  const [document, setDocument] = useState(null);

  useEffect(() => {
    if (!documentId) { setDocument(null); return; }
    api.get(`/documents/${documentId}`).then((r) => setDocument(r.data)).catch(() => setDocument(null));
  }, [documentId]);

  if (!documentId) return null;
  const meta = KIND[document?.kind] ?? KIND.file;

  return (
    <Drawer
      open
      onClose={onClose}
      width="md"
      title={document?.name ?? 'File'}
      subtitle={document ? `${document.size_label} · version ${document.current_version}` : undefined}
      footer={
        document?.importable && (
          <Button variant="primary" icon={Table2} onClick={() => onImport(document)}>
            Import this sheet
          </Button>
        )
      }
    >
      {!document ? (
        <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
      ) : (
        <div className="space-y-6">
          <div className="flex items-center gap-4">
            <span className={cn('flex size-14 items-center justify-center rounded-[var(--radius-xl)]', meta.tint)}>
              <meta.icon className="size-7" strokeWidth={1.5} />
            </span>
            <a href={`${API_BASE}/api/documents/${document.id}/download`}>
              <Button variant="secondary" size="sm" icon={Download}>Download</Button>
            </a>
          </div>

          <DetailGrid
            items={[
              { label: 'Type', value: document.kind },
              { label: 'Size', value: document.size_label },
              { label: 'Folder', value: document.folder_name },
              { label: 'Uploaded', value: date(document.created_at, 'datetime') },
              { label: 'Description', value: document.description, full: true },
            ]}
          />

          {document.sheets?.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-medium text-[var(--text-secondary)]">Sheets</h3>
              <ul className="space-y-2">
                {document.sheets.map((sheet) => (
                  <li key={sheet.name} className="panel flex items-center justify-between gap-3 px-3 py-2.5">
                    <span className="truncate text-base">{sheet.name}</span>
                    <span className="shrink-0 text-xs tabular text-[var(--text-tertiary)]">
                      {sheet.total_rows} rows · {sheet.columns} columns
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {document.import_jobs?.length > 0 && (
            <div>
              <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium text-[var(--text-secondary)]">
                <History className="size-3.5" /> Past imports
              </h3>
              <ul className="space-y-2">
                {document.import_jobs.map((job) => (
                  <li key={job.id} className="panel px-3 py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm">{job.target_key}</span>
                      <Badge size="sm" tone={job.status === 'completed' ? 'positive' : job.status === 'failed' ? 'critical' : 'neutral'}>
                        {job.status}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs tabular text-[var(--text-tertiary)]">
                      {job.created_count} created · {job.updated_count} updated · {job.failed_count} failed
                      {' · '}{relativeTime(job.created_at)}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <h3 className="mb-2 text-sm font-medium text-[var(--text-secondary)]">
              Versions ({document.versions?.length ?? 0})
            </h3>
            <ul className="space-y-2">
              {document.versions?.map((version) => (
                <li key={version.id} className="panel flex items-center justify-between gap-3 px-3 py-2.5">
                  <span className="text-base">Version {version.version}</span>
                  <span className="text-xs tabular text-[var(--text-tertiary)]">
                    {version.size_label} · {relativeTime(version.created_at)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </Drawer>
  );
}

function NewFolderModal({ open, onClose, onCreated }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/documents/folders', { name });
      toast.success(`${name} created`);
      setName('');
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create that folder.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New folder"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={busy} icon={FolderPlus}>Create</Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert tone="critical">{error}</Alert>}
        <Field label="Folder name" required>
          {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} required data-autofocus
            placeholder="Contracts" />}
        </Field>
      </form>
    </Modal>
  );
}
