'use client';

import { useCallback, useEffect, useState } from 'react';
import { Mail, Send, RefreshCw, Server, CheckCircle2, AlertTriangle } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { relativeTime } from '@/lib/format';
import { useWorkspace } from '@/lib/workspace';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { Table, THead, TBody, TH, TR, TD, TableSkeleton } from '@/components/ui/table';
import { Pagination } from '@/components/data/list-shell';
import { Card, CardBody, EmptyState, PageHeader, Alert, Badge } from '@/components/ui/primitives';

const STATUS = {
  sent: { tone: 'positive', label: 'Sent' },
  logged: { tone: 'caution', label: 'Not sent (logged)' },
  failed: { tone: 'critical', label: 'Failed' },
  retrying: { tone: 'caution', label: 'Retrying' },
  sending: { tone: 'info', label: 'Sending' },
};
const TEMPLATE = {
  invitation: 'Invitation', verify_email: 'Confirm email', reset_password: 'Password reset', magic_link: 'Sign-in link',
  quote: 'Quotation', campaign: 'Campaign', sign_request: 'Signature request', booking_confirmation: 'Booking', partner_portal: 'Partner portal', notification: 'Notification', test: 'Test email',
};

export default function EmailsClient() {
  const toast = useToast();
  const { user } = useWorkspace();
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState(null);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [testTo, setTestTo] = useState('');
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.get('/notifications/emails', { query: { status: status || undefined, q: search || undefined, page, limit: 50 } });
      setRows(response.data);
      setMeta(response.meta);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the email log.');
    } finally {
      setLoading(false);
    }
  }, [status, search, page]);

  useEffect(() => {
    const timer = setTimeout(load, search ? 300 : 0);
    return () => clearTimeout(timer);
  }, [load, search]);

  async function sendTest() {
    setTesting(true);
    setResult(null);
    try {
      const response = await api.post('/notifications/emails/test', testTo.trim() ? { to: testTo.trim() } : {});
      setResult(response.data);
      if (response.data.status === 'sent') toast.success('Test email sent', { description: `Check ${response.data.to}.` });
      load();
    } catch (err) {
      toast.error('Could not send the test', { description: err instanceof ApiError ? err.message : undefined });
    } finally {
      setTesting(false);
    }
  }

  const here = meta?.this_server;
  const last = meta?.last_30_days ?? {};

  return (
    <div className="space-y-5">
      <PageHeader title="Email log" description="Every email this workspace sent — invitations, reminders, quotes — and what the mail service said." />

      <Card>
        <CardBody className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <Server className="size-4 text-[var(--text-tertiary)]" />
            {here ? (
              here.configured ? (
                <span className="text-sm">This server (<code>{here.server}</code>) sends through <strong>{here.transport}</strong> as <strong>{here.from}</strong>.</span>
              ) : (
                <span className="text-sm text-[var(--color-caution-700)]">This server (<code>{here.server}</code>) has <strong>no email settings</strong>: its emails are only written to its log.</span>
              )
            ) : <span className="text-sm text-[var(--text-tertiary)]">Checking mail settings…</span>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder={user?.email ?? 'you@company.com'} className="max-w-xs" icon={Mail} aria-label="Send the test to" />
            <Button variant="primary" icon={Send} loading={testing} onClick={sendTest}>Send test email</Button>
          </div>
          {result && (
            result.status === 'sent' ? (
              <Alert tone="positive" icon={CheckCircle2} title={`Accepted by ${result.transport}`}>The mail service replied: <code className="break-all">{result.response || 'OK'}</code>. If it does not arrive, check spam and the sender domain’s SPF/DKIM records.</Alert>
            ) : (
              <Alert tone="critical" icon={AlertTriangle} title={result.status === 'logged' ? 'Not sent' : 'The mail service refused it'}>
                <code className="break-all">{result.error}</code>
                <Hint error={result.error} />
              </Alert>
            )
          )}
        </CardBody>
      </Card>

      {(last.logged > 0 || last.failed > 0) && (
        <Alert tone="caution" title="Some emails did not go out in the last 30 days">
          {last.logged ? `${last.logged} were only logged` : ''}{last.logged && last.failed ? ' and ' : ''}{last.failed ? `${last.failed} failed` : ''}.
          {' '}“Logged” means the server that handled them had no SMTP settings. If the server names below differ, two copies of Nexus (for example your laptop and your live server) are using the same database and taking turns with your emails — give each its own database.
        </Alert>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="Search address or subject…" className="max-w-xs" />
        <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="w-auto" aria-label="Status">
          <option value="">All statuses</option>
          {Object.entries(STATUS).map(([value, s]) => <option key={value} value={value}>{s.label}</option>)}
        </Select>
        <div className="flex-1" />
        <Button variant="ghost" icon={RefreshCw} onClick={load}>Refresh</Button>
      </div>

      {error && <Alert tone="critical">{error}</Alert>}
      {loading && !rows.length ? <TableSkeleton rows={6} columns={5} /> : rows.length === 0 ? (
        <Card><EmptyState icon={Mail} title="No emails yet" description="Invitations, password resets and other emails appear here once they are sent." /></Card>
      ) : (
        <>
          <Table>
            <THead><tr><TH>To</TH><TH>Email</TH><TH>Status</TH><TH>Details</TH><TH>Server</TH><TH>When</TH></tr></THead>
            <TBody>
              {rows.map((r) => (
                <TR key={r.id}>
                  <TD className="text-sm">{r.to_address}</TD>
                  <TD>
                    <p className="text-sm font-medium">{TEMPLATE[r.template] ?? r.template}</p>
                    {r.subject && <p className="max-w-[18rem] truncate text-xs text-[var(--text-tertiary)]">{r.subject}</p>}
                  </TD>
                  <TD><Badge size="sm" tone={STATUS[r.status]?.tone}>{STATUS[r.status]?.label ?? r.status}</Badge>{r.attempts > 1 && <p className="mt-0.5 text-2xs text-[var(--text-tertiary)]">{r.attempts} attempts</p>}</TD>
                  <TD className="max-w-[22rem] text-xs text-[var(--text-secondary)]">
                    <span className="line-clamp-3 break-words">{r.error ?? r.response ?? '—'}</span>
                  </TD>
                  <TD className="text-xs text-[var(--text-secondary)]">{r.server ?? '—'}{r.transport && r.transport !== 'none' ? <><br />{r.transport}</> : null}</TD>
                  <TD className="text-sm text-[var(--text-secondary)]" title={new Date(r.created_at).toLocaleString('en-IN')}>{relativeTime(r.created_at)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <Pagination meta={meta} onPage={setPage} />
        </>
      )}
    </div>
  );
}

/** Plain-language next steps for the errors mail services actually give. */
function Hint({ error = '' }) {
  const e = error.toLowerCase();
  let hint = null;
  if (e.includes('no email settings')) hint = 'Set ZEPTOMAIL_TOKEN and MAIL_FROM (or the SMTP_ settings) on this server and redeploy it.';
  else if (/zeptomail 401|invalid.*token|unauthori[sz]ed/.test(e)) hint = 'The ZeptoMail token is wrong or revoked. In ZeptoMail open Mail Agents → your agent → SMTP/API → Send Mail token, and paste it into ZEPTOMAIL_TOKEN.';
  else if (/block outgoing smtp|etimedout|connection timeout/.test(e)) hint = 'This server cannot open an SMTP connection — Railway’s Free, Trial and Hobby plans block it. Set ZEPTOMAIL_TOKEN so mail goes through ZeptoMail’s web API instead.';
  else if (/535|auth|credential|username and password/.test(e)) hint = 'The SMTP username or password is wrong. ZeptoMail: use the SMTP user and password from Mail Agents → SMTP. Gmail: use a 16-letter App Password, not your normal password.';
  else if (/553|550|sender|not (allowed|verified|authori)|relay/.test(e)) hint = 'The “from” address is not allowed. ZeptoMail only sends from a domain verified in your Mail Agent (add its SPF and DKIM records); MAIL_FROM must use that domain. Gmail only sends as the signed-in Gmail address.';
  else if (/timed out|econnrefused|enotfound|connection/.test(e)) hint = 'This server could not reach the mail service. Check SMTP_HOST and SMTP_PORT (587, or 465 for SSL); some hosts block outgoing mail ports.';
  return hint ? <p className="mt-2 text-sm">{hint}</p> : null;
}
