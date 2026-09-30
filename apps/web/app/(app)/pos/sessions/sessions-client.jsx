'use client';

import { useEffect, useState } from 'react';
import { Clock } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { money, date } from '@/lib/format';
import { Table, THead, TBody, TH, TR, TD, TableSkeleton } from '@/components/ui/table';
import { Badge, Card, EmptyState, PageHeader, Alert } from '@/components/ui/primitives';

export default function SessionsClient() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    api.get('/pos/sessions').then((r) => setRows(r.data)).catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load sessions.'));
  }, []);
  return (
    <div className="space-y-5">
      <PageHeader title="Sessions" description="Every shift at every till: when it opened and closed, what it sold, and whether the cash drawer balanced." />
      {error && <Alert tone="critical">{error}</Alert>}
      {!rows ? <TableSkeleton rows={6} columns={6} /> : rows.length === 0 ? (
        <Card><EmptyState icon={Clock} title="No shifts yet" description="Open a till from Registers to start the first shift." /></Card>
      ) : (
        <Table>
          <THead><tr><TH>Register</TH><TH>Opened</TH><TH>Closed</TH><TH align="right">Sales</TH><TH align="right">Revenue</TH><TH align="right">Expected cash</TH><TH align="right">Counted</TH><TH align="right">Difference</TH></tr></THead>
          <TBody>
            {rows.map((s) => {
              const diff = s.counted_cash !== null && s.expected_cash !== null ? Number(s.counted_cash) - Number(s.expected_cash) : null;
              return (
                <TR key={s.id}>
                  <TD className="font-medium">{s.register_name} {s.status === 'open' && <Badge size="sm" tone="positive" dot>Open</Badge>}</TD>
                  <TD className="text-[var(--text-secondary)]">{date(s.opened_at, 'datetime')}</TD>
                  <TD className="text-[var(--text-secondary)]">{s.closed_at ? date(s.closed_at, 'datetime') : '—'}</TD>
                  <TD align="right" numeric>{s.sales}</TD>
                  <TD align="right" numeric>{money(s.revenue)}</TD>
                  <TD align="right" numeric>{s.expected_cash !== null ? money(s.expected_cash) : '—'}</TD>
                  <TD align="right" numeric>{s.counted_cash !== null ? money(s.counted_cash) : '—'}</TD>
                  <TD align="right" numeric className={cn(diff === null ? '' : diff === 0 ? 'text-[var(--color-positive-600)]' : 'font-medium text-[var(--color-critical-600)]')}>{diff === null ? '—' : diff === 0 ? 'Balanced' : money(diff)}</TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      )}
    </div>
  );
}
