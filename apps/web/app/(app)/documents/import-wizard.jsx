'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Table2, ArrowRight, ArrowLeft, Check, AlertTriangle, XCircle, Loader2,
  CheckCircle2, Wand2, SkipForward, RefreshCw, Plus,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Badge, Alert, Skeleton } from '@/components/ui/primitives';
import { Icon } from '@/components/shell/icon';

const STEPS = ['Where to', 'Match columns', 'Review', 'Done'];

/**
 * Four steps, and nothing is written until the third one is approved.
 *
 * The point of the wizard is that a person sees precisely what will happen —
 * which rows create, which update, which are skipped and which are rejected,
 * with the reason — before any record exists.
 */
export function ImportWizard({ document, onClose, onImported }) {
  const [step, setStep] = useState(0);
  const [targets, setTargets] = useState([]);
  const [targetKey, setTargetKey] = useState(null);
  const [sheetName, setSheetName] = useState(document.sheets?.[0]?.name ?? null);

  const [analysis, setAnalysis] = useState(null);
  const [mapping, setMapping] = useState({});
  const [validation, setValidation] = useState(null);
  const [result, setResult] = useState(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get('/documents/import/targets')
      .then((r) => setTargets(r.data))
      .catch(() => setTargets([]));
  }, []);

  const analyse = useCallback(async (key) => {
    setBusy(true);
    setError(null);
    try {
      const response = await api.post(`/documents/${document.id}/import/analyse`, {
        target_key: key,
        sheet_name: sheetName ?? undefined,
      });
      setAnalysis(response.data);
      setMapping(response.data.suggested_mapping);
      setStep(1);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not read that sheet.');
    } finally {
      setBusy(false);
    }
  }, [document.id, sheetName]);

  async function validate() {
    setBusy(true);
    setError(null);
    try {
      const response = await api.post(`/documents/${document.id}/import/validate`, {
        target_key: targetKey,
        sheet_name: sheetName ?? undefined,
        mapping,
      });
      setValidation(response.data);
      setStep(2);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not check that sheet.');
    } finally {
      setBusy(false);
    }
  }

  async function execute() {
    setBusy(true);
    setError(null);
    try {
      const response = await api.post(`/documents/import/${validation.job_id}/execute`, {
        skip_errors: true,
      });
      setResult(response.data);
      setStep(3);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The import could not be completed.');
    } finally {
      setBusy(false);
    }
  }

  const target = targets.find((t) => t.key === targetKey);
  const missingRequired = analysis
    ? analysis.target.fields.filter((f) => f.required && !Object.values(mapping).includes(f.key))
    : [];

  return (
    <Modal
      open
      onClose={onClose}
      size="full"
      title={`Import ${document.name}`}
      description={step < 3 ? 'Nothing is written until you approve the review step.' : undefined}
      footer={
        <>
          {step > 0 && step < 3 && (
            <Button variant="ghost" icon={ArrowLeft} onClick={() => setStep(step - 1)} disabled={busy}>
              Back
            </Button>
          )}
          {step === 0 && <Button variant="ghost" onClick={onClose}>Cancel</Button>}
          {step === 1 && (
            <Button variant="primary" iconRight={ArrowRight} onClick={validate}
              loading={busy} disabled={missingRequired.length > 0}>
              Check the data
            </Button>
          )}
          {step === 2 && (
            <Button
              variant="primary"
              icon={Check}
              onClick={execute}
              loading={busy}
              disabled={(validation?.summary?.will_create ?? 0) + (validation?.summary?.will_update ?? 0) === 0}
            >
              Import {(validation?.summary?.will_create ?? 0) + (validation?.summary?.will_update ?? 0)} rows
            </Button>
          )}
          {step === 3 && (
            <Button variant="primary" onClick={onImported}>Done</Button>
          )}
        </>
      }
    >
      <Stepper step={step} />

      {error && <Alert tone="critical" className="mt-4">{error}</Alert>}

      <div className="mt-5">
        {step === 0 && (
          <ChooseTarget
            targets={targets}
            sheets={document.sheets ?? []}
            sheetName={sheetName}
            onSheet={setSheetName}
            busy={busy}
            onChoose={(key) => { setTargetKey(key); analyse(key); }}
          />
        )}

        {step === 1 && analysis && (
          <MapColumns
            analysis={analysis}
            mapping={mapping}
            onChange={setMapping}
            missingRequired={missingRequired}
            onReset={() => setMapping(analysis.suggested_mapping)}
          />
        )}

        {step === 2 && validation && <Review validation={validation} target={target} />}

        {step === 3 && result && <Done result={result} />}
      </div>
    </Modal>
  );
}

function Stepper({ step }) {
  return (
    <ol className="flex items-center gap-2">
      {STEPS.map((label, index) => (
        <li key={label} className="flex flex-1 items-center gap-2">
          <span
            className={cn(
              'flex size-6 shrink-0 items-center justify-center rounded-full text-2xs font-semibold',
              index < step ? 'bg-[var(--color-positive-500)] text-white'
              : index === step ? 'bg-[var(--color-brand-600)] text-white ring-4 ring-[var(--color-brand-100)] dark:ring-[rgb(99_102_241/0.2)]'
              : 'bg-[var(--surface-active)] text-[var(--text-tertiary)]',
            )}
          >
            {index < step ? <Check className="size-3.5" strokeWidth={3} /> : index + 1}
          </span>
          <span className={cn('hidden text-sm font-medium sm:block',
            index <= step ? 'text-[var(--text-primary)]' : 'text-[var(--text-tertiary)]')}>
            {label}
          </span>
          {index < STEPS.length - 1 && (
            <span className={cn('h-px flex-1', index < step ? 'bg-[var(--color-positive-500)]' : 'bg-[var(--border-default)]')} />
          )}
        </li>
      ))}
    </ol>
  );
}

function ChooseTarget({ targets, sheets, sheetName, onSheet, onChoose, busy }) {
  if (targets.length === 0) {
    return (
      <Alert tone="caution" icon={AlertTriangle}>
        There is nowhere to import into yet. Add CRM or HR to this workspace first.
      </Alert>
    );
  }

  return (
    <div className="space-y-5">
      {sheets.length > 1 && (
        <div>
          <p className="mb-2 text-sm font-medium">Which sheet?</p>
          <Select value={sheetName ?? ''} onChange={(e) => onSheet(e.target.value)} className="max-w-sm">
            {sheets.map((sheet) => (
              <option key={sheet.name} value={sheet.name}>
                {sheet.name} — {sheet.total_rows} rows
              </option>
            ))}
          </Select>
        </div>
      )}

      <div>
        <p className="mb-2.5 text-sm font-medium">What should these rows become?</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {targets.map((target) => (
            <button
              key={target.key}
              onClick={() => onChoose(target.key)}
              disabled={busy}
              className="panel panel-hover flex items-start gap-3 p-4 text-left disabled:opacity-60"
            >
              <span className="flex size-10 shrink-0 items-center justify-center rounded-[var(--radius-lg)] bg-[var(--color-brand-50)] text-[var(--color-brand-600)] dark:bg-[rgb(99_102_241/0.14)] dark:text-[var(--color-brand-300)]">
                <Icon name={target.icon} className="size-5" />
              </span>
              <span className="min-w-0">
                <span className="block text-md font-semibold">{target.label}</span>
                <span className="mt-0.5 block text-sm text-[var(--text-secondary)]">
                  {target.description}
                </span>
                <span className="mt-1.5 block text-2xs text-[var(--text-tertiary)]">
                  Matched on {target.dedupe_on ?? 'nothing'} · {target.fields.length} fields
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function MapColumns({ analysis, mapping, onChange, missingRequired, onReset }) {
  const { sheet, target } = analysis;

  const setColumn = (header, field) => {
    const next = { ...mapping };
    // A field can only receive one column — clear any previous claim.
    if (field) for (const key of Object.keys(next)) if (next[key] === field) delete next[key];
    if (field) next[header] = field; else delete next[header];
    onChange(next);
  };

  const mappedCount = Object.values(mapping).filter(Boolean).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-base">
            <strong>{sheet.total_rows}</strong> rows · <strong>{mappedCount}</strong> of {sheet.columns.length} columns mapped
          </p>
          <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">
            Headers found on row {sheet.header_row + 1}. Unmapped columns are ignored.
          </p>
        </div>
        <Button variant="ghost" size="sm" icon={Wand2} onClick={onReset}>Reset to suggestions</Button>
      </div>

      {missingRequired.length > 0 && (
        <Alert tone="critical" icon={XCircle}>
          {missingRequired.map((f) => f.label).join(', ')} {missingRequired.length === 1 ? 'is' : 'are'} required.
          Map {missingRequired.length === 1 ? 'a column' : 'columns'} to continue.
        </Alert>
      )}

      <div className="overflow-hidden rounded-[var(--radius-xl)] border border-[var(--border-subtle)]">
        <table className="w-full text-base">
          <thead className="bg-[var(--surface-sunken)]">
            <tr>
              <th className="px-3.5 py-2.5 text-left text-xs font-medium text-[var(--text-tertiary)]">
                Spreadsheet column
              </th>
              <th className="px-3.5 py-2.5 text-left text-xs font-medium text-[var(--text-tertiary)]">
                Sample values
              </th>
              <th className="px-3.5 py-2.5 text-left text-xs font-medium text-[var(--text-tertiary)]">
                Imports as
              </th>
            </tr>
          </thead>
          <tbody>
            {sheet.columns.map((column) => {
              const assigned = mapping[column.header];
              return (
                <tr key={column.index} className="border-t border-[var(--border-subtle)]">
                  <td className="px-3.5 py-2.5 align-top">
                    <p className="font-medium">{column.header}</p>
                    <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">
                      {column.type} · {column.fill_rate}% filled
                      {column.unique && ' · all unique'}
                    </p>
                  </td>
                  <td className="px-3.5 py-2.5 align-top">
                    <div className="flex flex-wrap gap-1">
                      {column.samples.slice(0, 3).map((sample, i) => (
                        <span key={i} className="max-w-[12rem] truncate rounded-[var(--radius-xs)] bg-[var(--surface-sunken)] px-1.5 py-0.5 text-xs text-[var(--text-secondary)]">
                          {sample}
                        </span>
                      ))}
                      {column.blank > 0 && (
                        <span className="text-xs text-[var(--text-disabled)]">+{column.blank} blank</span>
                      )}
                    </div>
                  </td>
                  <td className="px-3.5 py-2.5 align-top">
                    <Select
                      value={assigned ?? ''}
                      onChange={(e) => setColumn(column.header, e.target.value || null)}
                      className={cn('min-w-[12rem]', !assigned && 'text-[var(--text-tertiary)]')}
                      aria-label={`Map ${column.header}`}
                    >
                      <option value="">Ignore this column</option>
                      {target.fields.map((field) => (
                        <option key={field.key} value={field.key}>
                          {field.label}{field.required ? ' *' : ''}
                        </option>
                      ))}
                    </Select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Review({ validation, target }) {
  const s = validation.summary;
  const problems = validation.rows ?? [];

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Outcome label="Will be created" value={s.will_create} tone="positive" icon={Plus} />
        <Outcome label="Will be updated" value={s.will_update} tone="brand" icon={RefreshCw} />
        <Outcome label="Will be skipped" value={s.will_skip} tone="neutral" icon={SkipForward} />
        <Outcome label="Rejected" value={s.will_fail} tone={s.will_fail > 0 ? 'critical' : 'neutral'} icon={XCircle} />
      </div>

      {s.will_fail > 0 && (
        <Alert tone="caution" icon={AlertTriangle}>
          {s.will_fail} row{s.will_fail === 1 ? '' : 's'} cannot be imported and will be left out.
          Everything else goes ahead.
        </Alert>
      )}

      {s.will_update > 0 && (
        <Alert tone="info" icon={RefreshCw}>
          {s.will_update} row{s.will_update === 1 ? '' : 's'} match an existing record
          {target?.dedupe_on ? ` on ${target.dedupe_on}` : ''} and will be updated — only the
          columns you mapped are touched.
        </Alert>
      )}

      {problems.length === 0 ? (
        <div className="panel flex items-center gap-3 p-4">
          <CheckCircle2 className="size-5 text-[var(--color-positive-500)]" />
          <p className="text-base">Every row looks good.</p>
        </div>
      ) : (
        <div>
          <p className="mb-2 text-sm font-medium text-[var(--text-secondary)]">
            Rows that need your attention
          </p>
          <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
            {problems.map((row) => (
              <div key={row.row_number} className="panel p-3">
                <div className="flex items-center gap-2">
                  <Badge size="sm" tone={row.severity === 'error' ? 'critical' : 'caution'}>
                    Row {row.row_number}
                  </Badge>
                  <span className="text-xs text-[var(--text-tertiary)]">
                    {row.outcome === 'failed' ? 'will be left out'
                      : row.outcome === 'skipped' ? 'will be skipped'
                      : row.outcome === 'updated' ? 'will update an existing record'
                      : 'will be created'}
                  </span>
                </div>
                <ul className="mt-1.5 space-y-1">
                  {row.issues.map((issue, i) => (
                    <li key={i} className="flex items-start gap-1.5 text-sm text-[var(--text-secondary)]">
                      {issue.severity === 'error'
                        ? <XCircle className="mt-0.5 size-3.5 shrink-0 text-[var(--color-critical-500)]" />
                        : <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-[var(--color-caution-500)]" />}
                      <span>{issue.column ? <strong>{issue.column}: </strong> : null}{issue.message}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Outcome({ label, value, tone, icon: IconComponent }) {
  const tones = {
    positive: 'text-[var(--color-positive-600)] dark:text-[var(--color-positive-500)]',
    brand: 'text-[var(--color-brand-600)] dark:text-[var(--color-brand-400)]',
    critical: 'text-[var(--color-critical-600)] dark:text-[var(--color-critical-500)]',
    neutral: 'text-[var(--text-primary)]',
  };
  return (
    <div className="panel p-3.5">
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-xs text-[var(--text-secondary)]">{label}</p>
        <IconComponent className="size-3.5 shrink-0 text-[var(--text-disabled)]" />
      </div>
      <p className={cn('metric mt-1.5 text-2xl font-semibold tracking-[-0.02em]', tones[tone])}>{value}</p>
    </div>
  );
}

function Done({ result }) {
  return (
    <div className="py-6 text-center">
      <div className="mx-auto flex size-14 items-center justify-center rounded-[var(--radius-2xl)] bg-[var(--color-positive-500)] text-white">
        <CheckCircle2 className="size-7" strokeWidth={1.75} />
      </div>
      <h3 className="mt-5 text-lg font-semibold tracking-[-0.02em]">Imported into {result.target}</h3>

      <div className="mx-auto mt-6 grid max-w-lg grid-cols-2 gap-3 sm:grid-cols-4">
        <Outcome label="Created" value={result.created} tone="positive" icon={Plus} />
        <Outcome label="Updated" value={result.updated} tone="brand" icon={RefreshCw} />
        <Outcome label="Skipped" value={result.skipped} tone="neutral" icon={SkipForward} />
        <Outcome label="Left out" value={result.errors_skipped} tone={result.errors_skipped > 0 ? 'critical' : 'neutral'} icon={XCircle} />
      </div>

      <p className="mt-5 text-sm text-[var(--text-secondary)]">
        The records are live in {result.target} now — with that app&apos;s own rules applied.
      </p>
    </div>
  );
}
