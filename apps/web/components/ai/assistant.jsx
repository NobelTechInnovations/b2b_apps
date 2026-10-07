'use client';
import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Sparkles, ArrowUp, X, Compass, Settings2, Check, Loader2, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace';
import { Button } from '@/components/ui/button';
import { Tour } from '@/components/tour/tour';

const STEPS = [
  { target: 'workspace-switcher', title: 'Your company workspace', body: 'Check the company name here. Data, permissions and AI connections belong to this company. Create a separate connection for each company you work with.' },
  { target: 'sidebar', title: 'Your apps, together', body: 'Open the apps enabled for your company. Start with Settings to add people and assign roles, then use the Marketplace to add apps.' },
  { target: 'search', title: 'Find your way quickly', body: 'Use search or ⌘K / Ctrl+K to jump between pages and apps.' },
  { target: 'workspace-page', title: 'Build your workflow', body: 'Create a board in Tasks, add work, and assign a person and due date. For a field you do not understand, use the question mark beside its label.' },
  { target: 'ai-launcher', title: 'Help whenever you need it', body: 'Ask for a walkthrough or a field explanation. Enable company data when you want the assistant to read records or prepare a change. Review each proposed change before applying it. Connect external agents in Settings → AI & agents.' },
];

export function Assistant() {
  const { organization, user } = useWorkspace();
  return <AssistantSession key={`${organization?.id}:${user?.id}`} />;
}

function AssistantSession() {
  const { portalOnly } = useWorkspace();
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [tour, setTour] = useState(false);
  const [field, setField] = useState('');
  const [draft, setDraft] = useState('');
  const [messages, setMessages] = useState([]);
  const [useData, setUseData] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [applying, setApplying] = useState('');
  const [outcomes, setOutcomes] = useState({});
  const [status, setStatus] = useState(null);
  const panel = useRef(null);
  const input = useRef(null);
  const end = useRef(null);
  const controller = useRef(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => { setField(''); }, [pathname]);
  useEffect(() => {
    const help = (event) => {
      setField(`${event.detail.field}${event.detail.hint ? ` — ${event.detail.hint}` : ''}`.slice(0, 200));
      setDraft(`What should I fill in “${event.detail.field}”? Please give an example.`);
      setOpen(true);
    };
    const startTour = () => { setOpen(false); setTour(true); };
    window.addEventListener('nexus:ai-help', help);
    window.addEventListener('nexus:ai-tour', startTour);
    return () => { window.removeEventListener('nexus:ai-help', help); window.removeEventListener('nexus:ai-tour', startTour); };
  }, []);
  useEffect(() => {
    if (!open) return;
    api.get('/ai/status').then((res) => setStatus(res.data)).catch(() => setStatus({ unavailable: true }));
    input.current?.focus();
    const key = (event) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [open]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [messages, busy]);
  async function send(event) {
    event?.preventDefault();
    if (!draft.trim() || busy) return;
    const next = [...messages, { role: 'user', content: draft.trim() }];
    setMessages(next); setDraft(''); setBusy(true); setError('');
    controller.current = new AbortController();
    try {
      const { data } = await api.post('/ai/chat', { messages: next.slice(-12).map(({ role, content }) => ({ role, content: content.slice(0, 6000) })), page: pathname || undefined, field: field || undefined, use_data: useData }, { signal: controller.current.signal, retry: false });
      setMessages([...next, { role: 'assistant', content: data.reply, proposals: data.proposals, activity: data.activity }]);
    } catch (e) { if (e.name !== 'AbortError') { setError(e.code === 'validation_failed' ? `Please check your question: ${Object.entries(e.fieldErrors).map(([name, message]) => `${name} ${message}`).join('; ') || e.message}` : e.message); setDraft(next.at(-1).content); setMessages(messages); } }
    finally { setBusy(false); }
  }
  async function apply(proposal) {
    setApplying(proposal.id); setError('');
    try {
      await api.post(`/ai/proposals/${proposal.id}/execute`, {}, { retry: false });
      setOutcomes((old) => ({ ...old, [proposal.id]: 'Applied' }));
      router.refresh();
    } catch (e) {
      setError(`${e.message} Check the record before trying again.`);
      setOutcomes((old) => ({ ...old, [proposal.id]: 'Check result' }));
    } finally { setApplying(''); }
  }
  return <>
    <button data-tour="ai-launcher" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-label="Ask Nexus AI"
      className="fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded-full bg-[var(--color-brand-700)] px-4 py-3 text-sm font-semibold text-white shadow-xl transition hover:-translate-y-0.5">
      <Sparkles className="size-4" /> Ask Nexus
    </button>
    {open && <section ref={panel} role="dialog" aria-label="Nexus AI assistant"
      className="fixed bottom-20 right-3 z-[70] flex max-h-[80vh] w-[440px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-raised)] shadow-2xl">
      <div className="bg-[var(--color-brand-700)] px-5 py-4 text-white">
        <div className="flex items-center justify-between"><div className="flex items-center gap-2"><Sparkles className="size-5" /><h2 className="font-semibold text-white">Nexus assistant</h2></div><button onClick={() => setOpen(false)} aria-label="Close assistant" className="rounded p-1 hover:bg-white/10"><X className="size-4" /></button></div>
        <p className="mt-1 text-sm text-white/75">Guidance for your workspace. Help with every step.</p>
      </div>
      <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-4 py-2">
        <Button variant="ghost" size="sm" icon={Compass} onClick={() => { setOpen(false); setTour(true); }}>Take a tour</Button>
        <Link href={portalOnly ? '/portal/ai' : '/settings/ai'} onClick={() => setOpen(false)} className="flex items-center gap-1 text-xs text-[var(--text-secondary)]"><Settings2 className="size-3.5" /> AI settings</Link>
        <button className="ml-auto p-1 text-[var(--text-tertiary)]" aria-label="Clear conversation" disabled={busy} onClick={() => { setMessages([]); setOutcomes({}); setError(''); }}><Trash2 className="size-3.5" /></button>
      </div>
      <div className="min-h-44 flex-1 space-y-4 overflow-y-auto p-4" aria-live="polite">
        {!messages.length && <div className="py-2"><p className="text-lg font-semibold">What would you like to do?</p><p className="mt-1 text-sm text-[var(--text-secondary)]">Ask what to fill in a form, how an app works, or where to start.</p><div className="mt-4 space-y-2">{['Help me set up my company', 'Explain tasks and project time', 'How do I connect an AI agent?'].map((text) => <button key={text} onClick={() => { setDraft(text); input.current?.focus(); }} className="block w-full rounded-lg bg-[var(--surface-sunken)] px-3 py-2 text-left text-sm hover:bg-[var(--surface-hover)]">{text}</button>)}</div></div>}
        {messages.map((message, index) => <div key={index} className={message.role === 'user' ? 'ml-8 rounded-xl bg-[var(--surface-active)] p-3' : 'mr-2'}>
          <p className="mb-1 text-2xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{message.role === 'user' ? 'You' : 'Nexus'}</p>
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{message.content}</p>
          {message.proposals?.map((proposal) => <div key={proposal.id} className="mt-3 rounded-lg border border-[var(--border-default)] p-3">
            <p className="text-sm font-semibold">Review change</p><p className="mt-1 break-all text-xs text-[var(--text-secondary)]">{proposal.action_id}</p>
            <pre className="my-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-[var(--surface-sunken)] p-2 text-xs">{JSON.stringify({ ...proposal.input.params, ...proposal.input.body }, null, 2)}</pre>
            <p className="mb-2 text-xs text-[var(--text-tertiary)]">Only applies in this company. Expires in 10 minutes.</p>
            <Button size="sm" variant="primary" disabled={Boolean(outcomes[proposal.id]) || Boolean(applying)} loading={applying === proposal.id} icon={outcomes[proposal.id] === 'Applied' ? Check : undefined} onClick={() => apply(proposal)}>{outcomes[proposal.id] ?? 'Apply this change'}</Button>
          </div>)}
        </div>)}
        {busy && <p className="flex items-center gap-2 text-sm text-[var(--text-tertiary)]"><Loader2 className="size-4 animate-spin" /> Working on your request…</p>}
        {error && <p role="alert" className="rounded-lg bg-[var(--surface-sunken)] p-3 text-sm">{error}</p>}
        {status && !status.configured && <p className="text-xs text-[var(--text-tertiary)]">{status.unavailable ? 'AI service is unavailable. Start the local AI service.' : 'Connect the model API in the server environment to chat. You can use the tour and set up MCP connections now.'}</p>}
        <div ref={end} />
      </div>
      <form onSubmit={send} className="border-t border-[var(--border-subtle)] p-4">
        {field && <p className="mb-2 truncate text-xs text-[var(--text-secondary)]">Field: {field}</p>}
        <label className="mb-3 flex items-center gap-2 text-xs text-[var(--text-secondary)]"><input type="checkbox" checked={useData} onChange={(e) => setUseData(e.target.checked)} disabled={busy} /> Use company data for this conversation</label>
        <div className="flex items-end gap-2 rounded-xl border border-[var(--border-default)] bg-[var(--surface-sunken)] p-2">
          <textarea ref={input} aria-label="Ask Nexus" value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={6000} rows={2} placeholder="Ask a question…" className="max-h-32 min-w-0 flex-1 resize-none bg-transparent px-1 text-sm outline-none" onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
          <button type="submit" disabled={busy || !draft.trim()} aria-label="Send question" className="rounded-lg bg-[var(--color-brand-700)] p-2 text-white disabled:opacity-40"><ArrowUp className="size-4" /></button>
        </div>
        <p className="mt-2 text-[10px] leading-relaxed text-[var(--text-tertiary)]">Your messages and field labels go to the configured AI provider. Company data is shared only when enabled. Form values are not read automatically.</p>
      </form>
    </section>}
    <Tour steps={STEPS} open={tour} onClose={() => setTour(false)} />
  </>;
}
