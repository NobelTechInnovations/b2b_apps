'use client';

import { useEffect, useRef, useState } from 'react';
import { Download, ExternalLink, FileText, Image as ImageIcon, Paperclip, Upload, X, ZoomIn } from 'lucide-react';
import { api, refreshSession } from '@/lib/api';
import { API_BASE } from '@/lib/api-base';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';

const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp)$/i;
const PDF = /\.pdf$/i;
const fileUrl = (documentId, inline) => `${API_BASE}/api/documents/${documentId}/download${inline ? '?inline=true' : ''}`;

/**
 * A task's files. Pictures show as thumbnails and open full size in a viewer;
 * PDFs open in a preview. Nothing downloads until Download is pressed.
 */
export function TaskFiles({ task, canEdit, canUpload, documents, busy, onAttach, onUnlink, onUploaded }) {
  const [viewing, setViewing] = useState(null);
  const [documentId, setDocumentId] = useState('');
  const [uploading, setUploading] = useState(false);
  const [problem, setProblem] = useState('');
  const input = useRef(null);
  const images = task.attachments.filter((a) => IMAGE.test(a.name));
  const others = task.attachments.filter((a) => !IMAGE.test(a.name));

  async function upload(files) {
    setProblem('');
    setUploading(true);
    try {
      for (const file of files) {
        if (file.size > 25 * 1024 * 1024) throw new Error(`${file.name} is larger than 25 MB.`);
        const form = new FormData();
        form.append('file', file, file.name);
        let response = await fetch(`${API_BASE}/api/documents/upload`, { method: 'POST', body: form, credentials: 'include' });
        if (response.status === 401 && await refreshSession()) {
          response = await fetch(`${API_BASE}/api/documents/upload`, { method: 'POST', body: form, credentials: 'include' });
        }
        const payload = await response.json().catch(() => null);
        if (!response.ok) throw new Error(payload?.error?.message ?? `Could not upload ${file.name}.`);
        await api.post(`/tasks/${task.id}/attachments`, { document_id: payload.data.id });
      }
      await onUploaded();
    } catch (error) {
      setProblem(error.message);
    } finally {
      setUploading(false);
      if (input.current) input.current.value = '';
    }
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 font-semibold"><Paperclip size={16} />Files{task.attachments.length > 0 && <span className="text-sm font-normal text-[var(--text-tertiary)]">{task.attachments.length}</span>}</h3>
        {canEdit && canUpload && (
          <>
            <input ref={input} type="file" multiple hidden accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.csv,.ppt,.pptx,.txt,.zip" onChange={(e) => e.target.files?.length && upload([...e.target.files])} />
            <Button size="sm" variant="secondary" icon={Upload} loading={uploading} onClick={() => input.current?.click()}>Upload</Button>
          </>
        )}
      </div>
      {problem && <p className="text-sm text-[var(--color-critical-600)]">{problem}</p>}

      {images.length > 0 && (
        <div className="grid grid-cols-3 gap-2">
          {images.map((a) => (
            <figure key={a.id} className="group relative overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-sunken)]">
              <button type="button" className="block aspect-square w-full" onClick={() => setViewing(a)} aria-label={`Preview ${a.name}`}>
                <Thumb attachment={a} />
                <span className="absolute inset-0 flex items-center justify-center bg-black/0 text-white opacity-0 transition group-hover:bg-black/30 group-hover:opacity-100"><ZoomIn size={20} /></span>
              </button>
              <figcaption className="truncate px-2 py-1 text-2xs text-[var(--text-secondary)]" title={a.name}>{a.name}</figcaption>
            </figure>
          ))}
        </div>
      )}

      {others.map((a) => (
        <div key={a.id} className="flex items-center gap-2 rounded-lg border border-[var(--border-subtle)] px-3 py-2 text-sm">
          <FileText size={16} className="shrink-0 text-[var(--text-tertiary)]" />
          <span className="min-w-0 flex-1 truncate" title={a.name}>{a.name}</span>
          {PDF.test(a.name) && <Button size="xs" variant="ghost" onClick={() => setViewing(a)}>Preview</Button>}
          <a href={fileUrl(a.document_id)} download={a.name}><Button size="xs" variant="ghost" icon={Download} aria-label={`Download ${a.name}`} /></a>
          {canEdit && <Button size="xs" variant="ghost" icon={X} aria-label={`Remove ${a.name} from this task`} disabled={busy} onClick={() => onUnlink(a)} />}
        </div>
      ))}

      {!task.attachments.length && <p className="text-sm text-[var(--text-secondary)]">No files yet.{canEdit && canUpload ? ' Upload a photo, PDF or document.' : ''}</p>}

      {canEdit && documents.length > 0 && (
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (documentId) onAttach(documentId).then(() => setDocumentId('')); }}>
          <Select aria-label="Document to attach" value={documentId} onChange={(e) => setDocumentId(e.target.value)}>
            <option value="">Or attach a file already in Documents…</option>
            {documents.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </Select>
          <Button type="submit" variant="secondary" disabled={!documentId} loading={busy}>Attach</Button>
        </form>
      )}

      <Modal open={Boolean(viewing)} onClose={() => setViewing(null)} title={viewing?.name} size="full"
        footer={viewing && (
          <>
            {canEdit && IMAGE.test(viewing.name) && <Button variant="danger-ghost" disabled={busy} onClick={() => { onUnlink(viewing); setViewing(null); }}>Remove from task</Button>}
            <div className="flex-1" />
            <a href={fileUrl(viewing.document_id, true)} target="_blank" rel="noreferrer"><Button variant="ghost" icon={ExternalLink}>Open in new tab</Button></a>
            <a href={fileUrl(viewing.document_id)} download={viewing.name}><Button variant="primary" icon={Download}>Download</Button></a>
          </>
        )}
      >
        {viewing && (IMAGE.test(viewing.name)
          ? <div className="flex max-h-[70vh] items-center justify-center overflow-auto rounded-lg bg-[var(--surface-sunken)]"><img src={fileUrl(viewing.document_id, true)} alt={viewing.name} className="max-h-[70vh] max-w-full object-contain" /></div>
          : <PdfPreview attachment={viewing} />)}
      </Modal>
    </section>
  );
}

/** A thumbnail; an expired sign-in is renewed once and the picture tried again. */
function Thumb({ attachment }) {
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  if (failed) return <span className="flex h-full w-full items-center justify-center text-[var(--text-tertiary)]"><ImageIcon size={22} /></span>;
  return (
    <img
      key={attempt}
      src={fileUrl(attachment.document_id, true)}
      alt={attachment.name}
      loading="lazy"
      className="h-full w-full object-cover"
      onError={async () => {
        if (attempt === 0 && await refreshSession()) setAttempt(1); else setFailed(true);
      }}
    />
  );
}

/**
 * PDFs are fetched and shown from a local copy: workspace pages refuse to be
 * framed (clickjacking protection), and that rule does not apply to it.
 */
function PdfPreview({ attachment }) {
  const [url, setUrl] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    let objectUrl = null;
    (async () => {
      let response = await fetch(fileUrl(attachment.document_id, true), { credentials: 'include' });
      if (response.status === 401 && await refreshSession()) response = await fetch(fileUrl(attachment.document_id, true), { credentials: 'include' });
      if (!response.ok) throw new Error('preview failed');
      objectUrl = URL.createObjectURL(new Blob([await response.arrayBuffer()], { type: 'application/pdf' }));
      if (live) setUrl(objectUrl); else URL.revokeObjectURL(objectUrl);
    })().catch(() => { if (live) setFailed(true); });
    return () => { live = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [attachment.document_id]);
  if (failed) return <p className="py-10 text-center text-sm text-[var(--text-secondary)]">This file cannot be previewed. Use Download.</p>;
  if (!url) return <div className="skeleton h-[70vh] w-full rounded-lg" />;
  return <iframe title={attachment.name} src={url} className="h-[70vh] w-full rounded-lg border border-[var(--border-subtle)] bg-white" />;
}
