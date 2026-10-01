'use client';

import { useEffect, useMemo, useState } from 'react';
import { Send } from 'lucide-react';
import { appBySlug, permissionLabel } from '@nexus/contracts';
import { api, ApiError } from '@/lib/api';
import { relativeTime } from '@/lib/format';
import { useWorkspace } from '@/lib/workspace';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Field, Select, Textarea } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Alert, Badge } from '@/components/ui/primitives';

const STATUS_TONE = { pending: 'caution', approved: 'positive', declined: 'neutral' };

/**
 * Ask an owner or admin for an app you cannot open, or one ability inside an
 * app you use ("Lead sources", "Import leads"). They get a notification and
 * approve or decline from Settings → People.
 */
export function RequestAccessModal({ open, onClose, appSlug: initialApp = '' }) {
  const toast = useToast();
  const { workspace, can } = useWorkspace();
  const [app, setApp] = useState(initialApp);
  const [permission, setPermission] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const [mine, setMine] = useState([]);

  useEffect(() => {
    if (!open) return;
    setApp(initialApp);
    setPermission('');
    setNote('');
    setProblem(null);
    api.get('/members/me/access-requests').then((r) => setMine(r.data)).catch(() => setMine([]));
  }, [open, initialApp]);

  const apps = useMemo(() => (workspace?.workspace_apps ?? [])
    .filter((slug) => (workspace?.installed ?? []).includes(slug))
    .map(appBySlug).filter(Boolean), [workspace]);
  const yours = new Set(workspace?.apps ?? []);
  // Abilities in the chosen app that this person does not have yet.
  const abilities = app && yours.has(app) ? (appBySlug(app)?.permissions ?? []).filter((p) => !can(p)) : [];

  async function send() {
    setBusy(true);
    setProblem(null);
    try {
      await api.post('/members/me/access-requests', { app_slug: app || undefined, permission: permission || undefined, note: note.trim() || undefined });
      toast.success('Request sent', { description: 'An owner or admin will see it and decide. You will get a notification.' });
      onClose();
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : 'Could not send the request.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Request access"
      description="Ask for an app, or for one more thing you can do inside an app you already use."
      footer={<><Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" icon={Send} loading={busy} disabled={!app && !note.trim()} onClick={send}>Send request</Button></>}
    >
      <div className="space-y-4">
        {problem && <Alert tone="critical">{problem}</Alert>}
        <Field label="App">
          {(p) => (
            <Select {...p} value={app} onChange={(e) => { setApp(e.target.value); setPermission(''); }}>
              <option value="">Something else (describe it below)</option>
              {apps.map((a) => <option key={a.slug} value={a.slug}>{a.name}{yours.has(a.slug) ? '' : ' — not shared with you'}</option>)}
            </Select>
          )}
        </Field>
        {abilities.length > 0 && (
          <Field label="What do you need to do?" hint="Leave as is to ask for the app in general.">
            {(p) => (
              <Select {...p} value={permission} onChange={(e) => setPermission(e.target.value)}>
                <option value="">—</option>
                {abilities.map((ability) => <option key={ability} value={ability}>{permissionLabel(ability)}</option>)}
              </Select>
            )}
          </Field>
        )}
        <Field label="Why do you need it?" hint="Optional, but it helps them decide.">
          {(p) => <Textarea {...p} rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="I handle the Meta ads leads and need to see Lead sources." />}
        </Field>
        {mine.length > 0 && (
          <div>
            <p className="mb-1.5 text-sm font-medium">Your recent requests</p>
            <ul className="space-y-1 text-sm">
              {mine.slice(0, 5).map((r) => (
                <li key={r.id} className="flex items-center gap-2">
                  <Badge size="sm" tone={STATUS_TONE[r.status]}>{r.status}</Badge>
                  <span className="min-w-0 flex-1 truncate">{r.permission_label ?? r.app_name ?? r.note}</span>
                  <span className="text-xs text-[var(--text-tertiary)]">{relativeTime(r.created_at)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  );
}
