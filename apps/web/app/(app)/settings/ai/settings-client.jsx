'use client';
import { useEffect, useState } from 'react';
import { Sparkles, Plug, Copy, ShieldCheck, Compass, Plus, X } from 'lucide-react';
import { api } from '@/lib/api';
import { appBySlug } from '@nexus/contracts';
import { useWorkspace } from '@/lib/workspace';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Checkbox } from '@/components/ui/input';
import { ConfirmModal } from '@/components/ui/modal';

export default function AiSettings() {
  const { workspace, user } = useWorkspace();
  const [connections, setConnections] = useState([]);
  const [activity, setActivity] = useState([]);
  const [status, setStatus] = useState(null);
  const [checking, setChecking] = useState(false);
  const [name, setName] = useState('');
  const [apps, setApps] = useState([]);
  const [write, setWrite] = useState(false);
  const [days, setDays] = useState('30');
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState(null);
  const [revoke, setRevoke] = useState(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const choices = [...(workspace.apps ?? []).filter((slug) => workspace.installed?.includes(slug)).map((slug) => ({ slug, name: appBySlug(slug)?.name ?? slug })), { slug: 'core', name: 'People & company settings' }, { slug: 'catalog', name: 'Marketplace' }, { slug: 'billing', name: 'Plan & billing' }];
  async function load() {
    const results = await Promise.allSettled([api.get('/account/agent-connections'), api.get('/ai/status'), api.get('/ai/activity')]);
    if (results[0].status === 'fulfilled') setConnections(results[0].value.data); else setError(results[0].reason.message);
    if (results[1].status === 'fulfilled') setStatus(results[1].value.data); else setStatus({ unavailable: true });
    if (results[2].status === 'fulfilled') setActivity(results[2].value.data);
  }
  useEffect(() => { load(); setEndpoint(`${window.location.origin}/api/mcp`); }, []);
  async function copy(text, label) {
    try { await navigator.clipboard.writeText(text); setCopied(label); } catch { setError('Copy is unavailable in this browser. Select and copy the text manually.'); }
  }
  async function checkModel() {
    setChecking(true); setError('');
    try {
      const { data } = await api.post('/ai/check', {}, { retry: false });
      setStatus((previous) => ({ ...previous, ...data }));
    } catch (e) {
      setStatus((previous) => ({ ...previous, verified: false }));
      setError(e.message);
    } finally { setChecking(false); }
  }
  async function create(event) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const { data } = await api.post('/account/agent-connections', { name, apps, allow_write: write, expires_in_days: Number(days) }, { retry: false });
      setSecret(data); setCreating(false); setName(''); setApps([]); setWrite(false); await load();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function remove() {
    setBusy(true); setError('');
    try { await api.del(`/account/agent-connections/${revoke.id}`, { retry: false }); if (secret?.id === revoke.id) setSecret(null); setRevoke(null); await load(); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  const snippet = JSON.stringify({ mcpServers: { nexus: { type: 'http', url: endpoint, headers: { Authorization: 'Bearer YOUR_NEXUS_CONNECTION_TOKEN' } } } }, null, 2);
  return <div className="max-w-4xl space-y-6">
    <div className="overflow-hidden rounded-2xl bg-[var(--color-brand-700)] p-7 text-white">
      <div className="mb-5 flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-white/70"><Sparkles className="size-4" /> Intelligence, in your workspace</div>
      <h2 className="text-2xl font-semibold tracking-tight text-white">Your company. Your AI agents.</h2>
      <p className="mt-2 max-w-xl text-sm leading-relaxed text-white/75">Get help in every app and connect agents to your work. Each connection uses one person’s permissions in this company.</p>
      <div className="mt-5 flex flex-wrap gap-3"><Button variant="secondary" icon={Plus} onClick={() => setCreating(true)}>New connection</Button><button className="flex items-center gap-2 text-sm text-white/90" onClick={() => window.dispatchEvent(new Event('nexus:ai-tour'))}><Compass className="size-4" /> Take the setup tour</button></div>
    </div>
    {error && <p role="alert" className="rounded-lg bg-[var(--surface-sunken)] p-3 text-sm">{error}</p>}
    <div className="grid gap-5 md:grid-cols-2">
      <div className="rounded-xl border border-[var(--border-subtle)] p-5"><div className="flex items-center gap-2 font-semibold"><Sparkles className="size-4 text-[var(--color-brand-600)]" /> In-app assistant</div><p className="mt-2 text-sm text-[var(--text-secondary)]">{status?.verified ? 'Connection tested successfully. Open Ask Nexus from any page.' : status?.configured ? 'API key configured. Test the connection to verify the provider.' : status?.unavailable ? 'Start the AI service to enable this feature.' : 'Add your model key to enable chat. Field help and tours are ready.'}</p><p className="mt-3 break-all font-mono text-xs text-[var(--text-tertiary)]">{status?.provider ? `${status.provider} · ` : ''}{status?.model ?? 'Loading model settings…'}</p>{status?.configured && <Button className="mt-3" size="sm" loading={checking} onClick={checkModel}>Test connection</Button>}{status && !status.configured && !status.unavailable && <p className="mt-3 text-xs leading-relaxed text-[var(--text-secondary)]">{status.problem ?? 'Set NVIDIA_API_KEY or ANTHROPIC_API_KEY on the server, then restart the AI service. The key stays on the server.'}</p>}</div>
      <div className="rounded-xl border border-[var(--border-subtle)] p-5"><div className="flex items-center gap-2 font-semibold"><ShieldCheck className="size-4 text-[var(--color-brand-600)]" /> Company & user access</div><p className="mt-2 text-sm text-[var(--text-secondary)]">Read-only by default. Choose apps, set an expiry and revoke access at any time. An agent never gains more access than its user.</p><p className="mt-3 break-all text-xs text-[var(--text-tertiary)]">Company: {workspace.organization.id}</p></div>
    </div>
    {creating && <form onSubmit={create} className="space-y-4 rounded-xl border border-[var(--border-default)] bg-[var(--surface-raised)] p-5">
      <div className="flex items-center justify-between"><h3 className="font-semibold">Create a connection</h3><button type="button" aria-label="Close form" onClick={() => setCreating(false)}><X className="size-4" /></button></div>
      <div className="grid gap-4 sm:grid-cols-2"><Field label="Connection name" required>{(props) => <Input {...props} value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={80} placeholder="My work agent" />}</Field><Field label="Expires after">{(props) => <Select {...props} value={days} onChange={(e) => setDays(e.target.value)}><option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option></Select>}</Field></div>
      <fieldset><legend className="mb-2 text-sm font-medium">Apps this agent can use</legend><div className="grid gap-2 sm:grid-cols-2">{choices.map((app) => <Checkbox key={app.slug} label={app.name} checked={apps.includes(app.slug)} onChange={(e) => setApps((old) => e.target.checked ? [...old, app.slug] : old.filter((slug) => slug !== app.slug))} />)}</div></fieldset>
      <Checkbox label="Allow this agent to make changes" description="Includes creating, updating and deleting records where you have permission. Your external agent controls when to ask for confirmation." checked={write} onChange={(e) => setWrite(e.target.checked)} />
      <Button type="submit" variant="primary" loading={busy} disabled={!apps.length || !name.trim()}>Create connection</Button>
    </form>}
    {secret && <div className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-sunken)] p-5"><h3 className="font-semibold">Copy your token now</h3><p className="mt-1 text-sm text-[var(--text-secondary)]">This is the only time it is shown. Store it in your agent’s secret settings.</p><div className="mt-3 flex items-center gap-2"><input aria-label="New MCP token" readOnly type="password" value={secret.token} autoComplete="off" className="min-w-0 flex-1 rounded-lg border border-[var(--border-default)] bg-[var(--surface-raised)] p-2 font-mono text-xs" /><Button size="sm" icon={Copy} onClick={() => copy(secret.token, 'token')}>{copied === 'token' ? 'Copied' : 'Copy token'}</Button></div><button className="mt-3 text-xs underline" onClick={() => setSecret(null)}>I saved it · hide token</button></div>}
    <section><div className="mb-3 flex items-center justify-between"><h3 className="font-semibold">Connections in this company</h3><Button size="sm" variant="ghost" onClick={load}>Refresh</Button></div><div className="divide-y divide-[var(--border-subtle)] rounded-xl border border-[var(--border-subtle)]">{!connections.length && <p className="p-5 text-sm text-[var(--text-tertiary)]">No connections yet. Create one for your first agent.</p>}{connections.map((connection) => {
      const inactive = connection.revoked_at || new Date(connection.expires_at) < new Date();
      return <div key={connection.id} className="flex items-start justify-between gap-3 p-4"><div className="min-w-0"><p className="font-medium">{connection.name} <span className="ml-1 text-xs font-normal text-[var(--text-tertiary)]">{connection.user_id === user.id ? 'Yours' : 'Team member'}</span></p><p className="mt-1 text-xs text-[var(--text-secondary)]">{connection.apps.join(', ')} · {connection.allow_write ? 'Can make changes' : 'Read-only'}</p><p className="mt-1 text-xs text-[var(--text-tertiary)]">{connection.revoked_at ? 'Revoked' : `${inactive ? 'Expired' : 'Expires'} ${new Date(connection.expires_at).toLocaleDateString()}`}{connection.last_used_at ? ` · Last used ${new Date(connection.last_used_at).toLocaleString()}` : ' · Not used yet'}</p></div>{!inactive && <Button size="sm" variant="ghost" onClick={() => setRevoke(connection)}>Revoke</Button>}</div>;
    })}</div></section>
    <section className="rounded-xl bg-[var(--surface-sunken)] p-5"><h3 className="flex items-center gap-2 font-semibold"><Plug className="size-4" /> Connect your agent</h3><ol className="mt-3 list-inside list-decimal space-y-2 text-sm text-[var(--text-secondary)]"><li>Choose a client with MCP Streamable HTTP and bearer-token support.</li><li>Use this URL: <code className="break-all">{endpoint}</code></li><li>Set the Authorization header to <code>Bearer</code> followed by your connection token.</li><li>Ask the agent to list apps, discover actions, then describe the action’s fields.</li></ol><p className="mt-3 text-xs text-[var(--text-tertiary)]">Configuration keys vary by client. OAuth-only connectors are not supported yet. A cloud agent cannot reach localhost; use a local agent while reviewing.</p><details className="mt-4"><summary className="cursor-pointer text-sm font-medium">Example client configuration</summary><pre className="mt-3 overflow-x-auto rounded-lg bg-[var(--surface-raised)] p-3 text-xs">{snippet}</pre><Button className="mt-2" size="sm" icon={Copy} onClick={() => copy(snippet, 'config')}>{copied === 'config' ? 'Copied' : 'Copy example'}</Button></details></section>
    <section><h3 className="mb-3 font-semibold">Recent AI operations</h3>{!activity.length ? <p className="text-sm text-[var(--text-tertiary)]">Operations will appear here after an agent reads or changes a record.</p> : <div className="divide-y divide-[var(--border-subtle)]">{activity.map((item) => <div key={item.id} className="flex justify-between gap-3 py-3 text-xs"><div className="min-w-0"><p className="break-all font-mono">{item.action_id}</p><p className="mt-1 text-[var(--text-tertiary)]">{item.source} · {new Date(item.created_at).toLocaleString()}</p></div><span>{item.status}</span></div>)}</div>}</section>
    <ConfirmModal open={Boolean(revoke)} onClose={() => setRevoke(null)} onConfirm={remove} title={`Revoke ${revoke?.name ?? 'connection'}?`} description="The agent will lose access to this company. You can create a new connection later." confirmLabel="Revoke connection" danger loading={busy} />
  </div>;
}
