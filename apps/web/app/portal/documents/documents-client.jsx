'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  FileText, CheckCircle2, AlertTriangle, Printer, Paperclip, ChevronRight,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Textarea, Field } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Drawer } from '@/components/data/drawer';
import { Badge, Card, EmptyState, Alert, Skeleton } from '@/components/ui/primitives';
import { Markdown } from '@/components/data/markdown';
import { date as fmtDate } from '@/lib/format';

const KIND_LABEL = {
  offer: 'Offer letter', appointment: 'Appointment letter', confirmation: 'Confirmation',
  increment: 'Increment letter', promotion: 'Promotion letter', experience: 'Experience certificate',
  relieving: 'Relieving letter', warning: 'Warning', noc: 'No-objection certificate',
  id_proof: 'Identity document', certificate: 'Certificate', contract: 'Contract', custom: 'Document',
};

export default function PortalDocuments() {
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await api.get('/hr/me/documents');
      setRows(response.data);
      setMeta(response.meta ?? {});
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load your documents.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-[-0.02em]">Documents</h1>
        <p className="mt-1 text-base text-[var(--text-secondary)]">
          Letters and certificates your employer has issued to you.
        </p>
      </div>

      {error && <Alert tone="critical">{error}</Alert>}

      {meta.awaiting_acknowledgement > 0 && (
        <Alert
          tone="caution"
          icon={AlertTriangle}
          title={`${meta.awaiting_acknowledgement} ${meta.awaiting_acknowledgement === 1 ? 'document needs' : 'documents need'} your acknowledgement`}
        >
          Open each one, read it, and confirm you have received it.
        </Alert>
      )}

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {[0, 1].map((i) => <Skeleton key={i} className="h-32 w-full" />)}
        </div>
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={FileText}
            title="No documents yet"
            description="Offer letters, confirmations and certificates appear here as your employer issues them."
          />
        </Card>
      ) : (
        <div className="stagger grid gap-4 sm:grid-cols-2">
          {rows.map((row) => {
            const pending = row.requires_acknowledgement && !row.acknowledged_at;
            return (
              <Card
                key={row.id}
                interactive
                onClick={() => setOpen(row.id)}
                className="panel-hover flex flex-col p-5"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <Badge tone="neutral" size="sm">{KIND_LABEL[row.kind] ?? row.kind}</Badge>
                    <h3 className="mt-2 line-clamp-2 text-md font-semibold">{row.title}</h3>
                  </div>
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-lg)] bg-[var(--surface-sunken)] text-[var(--text-tertiary)]">
                    {row.has_letter ? <FileText className="size-4" /> : <Paperclip className="size-4" />}
                  </span>
                </div>

                <p className="mt-2 text-xs tabular text-[var(--text-tertiary)]">
                  {row.reference}
                  {row.issued_on && ` · issued ${fmtDate(row.issued_on)}`}
                </p>

                <div className="mt-auto flex items-center gap-2 pt-4">
                  {pending ? (
                    <Badge tone="caution" size="sm">
                      <AlertTriangle className="size-3" />Needs acknowledgement
                    </Badge>
                  ) : row.acknowledged_at ? (
                    <Badge tone="positive" size="sm">
                      <CheckCircle2 className="size-3" />Acknowledged
                    </Badge>
                  ) : (
                    <Badge tone="neutral" size="sm">Issued</Badge>
                  )}
                  <ChevronRight className="ml-auto size-4 text-[var(--text-tertiary)]" />
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {open && (
        <DocumentDrawer
          documentId={open}
          onClose={() => setOpen(null)}
          onChanged={load}
        />
      )}
    </div>
  );
}

function DocumentDrawer({ documentId, onClose, onChanged }) {
  const toast = useToast();
  const [document, setDocument] = useState(null);
  const [loading, setLoading] = useState(true);
  const [acknowledging, setAcknowledging] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await api.get(`/hr/me/documents/${documentId}`);
      setDocument(response.data);
    } catch {
      setDocument(null);
    } finally {
      setLoading(false);
    }
  }, [documentId]);

  useEffect(() => { load(); }, [load]);

  const pending = document?.requires_acknowledgement && !document?.acknowledged_at;

  return (
    <>
      <Drawer
        open
        onClose={onClose}
        title={document?.title ?? 'Document'}
        subtitle={document?.reference}
        badge={document?.acknowledged_at && <Badge tone="positive">Acknowledged</Badge>}
        width="lg"
        footer={
          document && (
            <div className="flex w-full items-center gap-2">
              {document.body && (
                <Button variant="ghost" icon={Printer} onClick={() => window.print()}>
                  Print
                </Button>
              )}
              <div className="flex-1" />
              {pending && (
                <Button variant="primary" icon={CheckCircle2} onClick={() => setAcknowledging(true)}>
                  I have read this
                </Button>
              )}
            </div>
          )
        }
      >
        {loading ? (
          <Skeleton className="h-96 w-full" />
        ) : !document ? (
          <EmptyState icon={FileText} title="Document not found" />
        ) : (
          <div className="space-y-4">
            {pending && (
              <Alert tone="caution" icon={AlertTriangle}>
                Your employer has asked you to confirm you have received and read this.
              </Alert>
            )}

            {document.acknowledged_at && (
              <Alert tone="positive" icon={CheckCircle2}>
                You acknowledged this on {fmtDate(document.acknowledged_at, 'datetime')}.
              </Alert>
            )}

            {document.body ? (
              <div className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-white px-8 py-7 text-[#111827] shadow-sm print:border-0 print:shadow-none">
                <Markdown>{document.body}</Markdown>
              </div>
            ) : (
              <EmptyState
                icon={Paperclip}
                title={document.file_name ?? 'Attached file'}
                description="This document was uploaded rather than written here."
              />
            )}

            {document.valid_until && (
              <p className="text-xs text-[var(--text-tertiary)]">
                Valid until {fmtDate(document.valid_until)}.
              </p>
            )}
          </div>
        )}
      </Drawer>

      {acknowledging && (
        <AcknowledgeModal
          documentId={documentId}
          title={document.title}
          onClose={() => setAcknowledging(false)}
          onDone={async () => {
            setAcknowledging(false);
            await load();
            await onChanged();
            toast.success('Acknowledged', { description: 'Your employer has been notified.' });
          }}
        />
      )}
    </>
  );
}

function AcknowledgeModal({ documentId, title, onClose, onDone }) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await api.post(`/hr/me/documents/${documentId}/acknowledge`, {
        note: note.trim() || undefined,
      });
      await onDone();
    } catch (err) {
      toast.error('Could not acknowledge that', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Acknowledge this document"
      description={`Confirming that you have received and read “${title}”. The date and time are recorded.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={busy}>Confirm</Button>
        </>
      }
    >
      <Field label="Anything to add" hint="Optional — it is stored with your acknowledgement">
        <Textarea
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Received and accepted."
        />
      </Field>
    </Modal>
  );
}
