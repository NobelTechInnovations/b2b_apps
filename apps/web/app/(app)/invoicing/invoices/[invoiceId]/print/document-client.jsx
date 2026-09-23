'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Printer, ArrowLeft, AlertTriangle, Palette } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/input';
import { EmptyState, Skeleton } from '@/components/ui/primitives';
import { InvoiceDocumentBody } from '@/components/invoicing/invoice-document';

/**
 * The invoice as a document.
 *
 * Printed from the browser, which produces a real PDF on every platform with
 * no headless renderer to run and keep in step. The layout is A4 and the
 * `print:` rules take the app chrome off the page, so what comes out is the
 * invoice rather than a screenshot of a web page.
 */
export default function InvoiceDocument({ invoiceId }) {
  const [doc, setDoc] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [previewId, setPreviewId] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get(`/invoicing/invoices/${invoiceId}/document`, {
      query: previewId ? { template_id: previewId } : undefined,
    })
      .then((r) => setDoc(r.data))
      .catch(() => setDoc(null))
      .finally(() => setLoading(false));
  }, [invoiceId, previewId]);

  useEffect(() => {
    api.get('/invoicing/templates').then((r) => setTemplates(r.data)).catch(() => setTemplates([]));
  }, []);

  if (loading) return <div className="mx-auto max-w-3xl p-8"><Skeleton className="h-[60vh] w-full" /></div>;
  if (!doc) {
    return (
      <div className="mx-auto max-w-3xl p-8">
        <EmptyState icon={AlertTriangle} title="Invoice not found" />
      </div>
    );
  }

  const isDraft = doc.invoice.status === 'draft';

  return (
    <>
      <div className="no-print sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--surface-raised)] px-5 py-3">
        <Link href="/invoicing/invoices">
          <Button variant="ghost" icon={ArrowLeft}>Back to invoices</Button>
        </Link>

        <div className="flex-1" />

        {templates.length > 1 && (
          <Select
            value={previewId}
            onChange={(e) => setPreviewId(e.target.value)}
            className="w-auto min-w-[12rem]"
            aria-label="Preview with a different design"
          >
            <option value="">
              {isDraft ? 'Default design' : 'As issued'}
            </option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>Preview: {t.name}</option>
            ))}
          </Select>
        )}

        <Link href="/invoicing/templates">
          <Button variant="ghost" icon={Palette}>Design</Button>
        </Link>

        <Button variant="primary" icon={Printer} onClick={() => window.print()}>
          Print or save as PDF
        </Button>
      </div>

      {previewId && !isDraft && (
        <p className="no-print mx-auto mt-4 max-w-[820px] rounded-[var(--radius-md)] border border-[var(--color-caution-500)] bg-[var(--color-caution-50)] px-3 py-2 text-sm text-[var(--color-caution-700)] dark:bg-[rgb(245_158_11/0.1)] dark:text-[var(--color-caution-500)]">
          Previewing a different design. {doc.invoice.number} was issued under its own template and
          will keep rendering that way for anyone who has it.
        </p>
      )}

      <div className="mx-auto my-8 max-w-[820px] bg-white px-10 py-9 text-[#111827] shadow-lg print:my-0 print:max-w-none print:px-0 print:py-0 print:shadow-none">
        <InvoiceDocumentBody doc={doc} />
      </div>

      <style jsx global>{`
        @media print {
          @page { size: A4; margin: 14mm; }
          .no-print, aside, header[data-app-header] { display: none !important; }
          body { background: #fff !important; }
          section, table, tfoot { break-inside: avoid; }
          thead { display: table-header-group; }
        }
      `}</style>
    </>
  );
}
