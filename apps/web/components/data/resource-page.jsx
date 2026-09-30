'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { Plus, Pencil, Trash2, Inbox } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { money, date as fmtDate } from '@/lib/format';
import { useWorkspace } from '@/lib/workspace';
import { titleCase } from '@/lib/people';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Field, Select, Textarea, Checkbox } from '@/components/ui/input';
import { Modal, ConfirmModal } from '@/components/ui/modal';
import { Drawer, DetailGrid } from '@/components/data/drawer';
import { ListToolbar, Pagination } from '@/components/data/list-shell';
import { Table, THead, TBody, TH, TR, TD, TableSkeleton } from '@/components/ui/table';
import { Badge, Card, EmptyState, PageHeader, Alert } from '@/components/ui/primitives';

/**
 * A complete list-and-record screen from a description: search, filters,
 * pagination, a create/edit form, a detail drawer and deep links
 * (?open=<id>, ?new=1). The API side is `resource()` in service-kit, so the
 * two halves agree on shape without each app re-deciding it.
 *
 * Anything an app needs beyond records — receiving goods, performing a
 * check — goes in `actions` and `detail`, which get the record and a reload.
 */
export function ResourcePage({
  title, description, endpoint, entity = 'record', permissions = {},
  columns, filters = [], searchPlaceholder = 'Search…', fields = [], defaults = {},
  detail, detailItems, actions, headerActions, stats, emptyIcon: EmptyIcon = Inbox, emptyText,
  toForm, fromForm, query: fixedQuery, drawerWidth = 'md', titleOf = (r) => r.name ?? r.title ?? r.number, subtitleOf, badgeOf,
  onChanged, rowAction,
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const toast = useToast();
  const { can } = useWorkspace();

  const [rows, setRows] = useState(null);
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [values, setValues] = useState({});
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState(null); // {} = new
  const [openId, setOpenId] = useState(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (params.get('new') === '1' && can(permissions.create)) setEditing({ ...defaults });
    if (params.get('open')) setOpenId(params.get('open'));
  }, [params]);

  const fixed = JSON.stringify(fixedQuery ?? {});
  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await api.get(endpoint, { query: { ...JSON.parse(fixed), ...values, q: search || undefined, page, limit: 25 } });
      setRows(response.data);
      setMeta(response.meta);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Could not load ${title.toLowerCase()}.`);
    }
  }, [endpoint, fixed, values, search, page, title]);

  useEffect(() => {
    const timer = setTimeout(load, search ? 280 : 0);
    return () => clearTimeout(timer);
  }, [load, search, version]);

  const reload = () => { setVersion((v) => v + 1); onChanged?.(); };
  const clearParam = () => { if (params.get('open') || params.get('new')) router.replace(pathname); };

  return (
    <div className="space-y-5">
      <PageHeader
        title={title}
        description={description}
        actions={
          <div className="flex flex-wrap gap-2">
            {headerActions}
            {fields.length > 0 && can(permissions.create) && (
              <Button variant="primary" icon={Plus} onClick={() => setEditing({ ...defaults })}>New {entity}</Button>
            )}
          </div>
        }
      />

      {stats?.(meta, rows)}

      <ListToolbar
        search={search}
        onSearch={(v) => { setSearch(v); setPage(1); }}
        searchPlaceholder={searchPlaceholder}
        filters={filters}
        values={values}
        onFilter={(key, value) => { setValues((c) => { const n = { ...c }; if (value === undefined) delete n[key]; else n[key] = value; return n; }); setPage(1); }}
        onClear={() => { setValues({}); setPage(1); }}
      />

      {error && <Alert tone="critical">{error}</Alert>}

      {!rows ? <TableSkeleton rows={6} columns={Math.min(columns.length, 6)} /> : rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={EmptyIcon}
            title={search || Object.keys(values).length ? `No ${title.toLowerCase()} match` : `No ${title.toLowerCase()} yet`}
            description={search || Object.keys(values).length ? 'Try clearing a filter or searching for something broader.' : emptyText}
            action={fields.length > 0 && can(permissions.create) && !search && (
              <Button variant="primary" icon={Plus} onClick={() => setEditing({ ...defaults })}>New {entity}</Button>
            )}
          />
        </Card>
      ) : (
        <>
          <Table>
            <THead>
              <tr>{columns.map((c) => <TH key={c.key} align={c.align} width={c.width}>{c.label}</TH>)}</tr>
            </THead>
            <TBody>
              {rows.map((row) => (
                <TR key={row.id} onClick={() => (rowAction ? rowAction(row) : setOpenId(row.id))}>
                  {columns.map((c) => (
                    <TD key={c.key} align={c.align} numeric={c.numeric} className={c.className}>
                      {c.render ? c.render(row) : renderValue(row[c.key], c.format)}
                    </TD>
                  ))}
                </TR>
              ))}
            </TBody>
          </Table>
          <Pagination meta={meta} onPage={setPage} />
        </>
      )}

      {editing && (
        <RecordForm
          endpoint={endpoint}
          entity={entity}
          fields={fields}
          record={editing}
          toForm={toForm}
          fromForm={fromForm}
          onClose={() => { setEditing(null); clearParam(); }}
          onSaved={(saved, isNew) => {
            toast.success(isNew ? `${titleCase(entity)} created` : 'Saved');
            reload();
            if (isNew && detail !== false) setOpenId(saved.id);
          }}
        />
      )}

      {openId && !editing && (
        <RecordDrawer
          endpoint={endpoint}
          id={openId}
          entity={entity}
          fields={fields}
          permissions={permissions}
          detail={detail}
          detailItems={detailItems}
          actions={actions}
          width={drawerWidth}
          titleOf={titleOf}
          subtitleOf={subtitleOf}
          badgeOf={badgeOf}
          onEdit={(record) => setEditing(record)}
          onClose={() => { setOpenId(null); clearParam(); }}
          onChanged={reload}
          version={version}
        />
      )}
    </div>
  );
}

/** How a plain value reads in a table or a detail grid. */
export function renderValue(value, format) {
  if (value === null || value === undefined || value === '') return <span className="text-[var(--text-disabled)]">—</span>;
  if (format === 'money') return money(value);
  if (format === 'date') return fmtDate(value);
  if (format === 'datetime') return fmtDate(value, 'datetime');
  if (format === 'number') return Number(value).toLocaleString('en-IN', { maximumFractionDigits: 3 });
  if (format === 'bool' || typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (format === 'label') return titleCase(String(value));
  if (typeof format === 'object' && format?.tones) return <Badge size="sm" tone={format.tones[value] ?? 'neutral'}>{format.labels?.[value] ?? titleCase(String(value))}</Badge>;
  return String(value);
}

/* ── the drawer ───────────────────────────────────────────────────────────── */

function RecordDrawer({ endpoint, id, entity, fields, permissions, detail, detailItems, actions, width, titleOf, subtitleOf, badgeOf, onEdit, onClose, onChanged, version }) {
  const toast = useToast();
  const { can } = useWorkspace();
  const [record, setRecord] = useState(null);
  const [error, setError] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setRecord((await api.get(`${endpoint}/${id}`)).data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Could not open that ${entity}.`);
    }
  }, [endpoint, id, entity]);
  useEffect(() => { load(); }, [load, version]);

  const refresh = async () => { await load(); onChanged(); };

  /** For action buttons: call, toast, refresh — or explain what went wrong. */
  const act = async (fn, success) => {
    setBusy(true);
    try {
      const result = await fn();
      if (success) toast.success(success);
      await refresh();
      return result;
    } catch (err) {
      toast.error('That did not work', { description: err instanceof ApiError ? err.message : undefined });
      return null;
    } finally {
      setBusy(false);
    }
  };

  async function remove() {
    try {
      await api.del(`${endpoint}/${id}`);
      toast.success(`${titleCase(entity)} deleted`);
      onChanged();
      onClose();
    } catch (err) {
      setDeleting(false);
      toast.error('Could not delete', { description: err instanceof ApiError ? err.message : undefined });
    }
  }

  const helpers = { reload: refresh, act, busy, close: onClose };
  const items = record && (detailItems ? detailItems(record) : fields.filter((f) => !f.hideInDetail).map((f) => ({
    label: f.label, full: f.full || f.type === 'textarea',
    value: f.render ? f.render(record) : renderFieldValue(f, record),
  })));

  return (
    <Drawer
      open
      onClose={onClose}
      width={width}
      title={record ? titleOf(record) : 'Loading…'}
      subtitle={record ? subtitleOf?.(record) : undefined}
      badge={record ? badgeOf?.(record) : undefined}
      footer={record && (
        <>
          {permissions.delete && can(permissions.delete) && (
            <Button variant="danger-ghost" icon={Trash2} onClick={() => setDeleting(true)}>Delete</Button>
          )}
          <div className="flex-1" />
          {actions?.(record, helpers)}
          {fields.length > 0 && permissions.edit && can(permissions.edit) && (
            <Button variant="secondary" icon={Pencil} onClick={() => onEdit(record)}>Edit</Button>
          )}
        </>
      )}
    >
      {error && <Alert tone="critical">{error}</Alert>}
      {record && (
        <div className="space-y-6">
          {items?.length > 0 && <DetailGrid items={items} />}
          {detail?.(record, helpers)}
        </div>
      )}
      <ConfirmModal
        open={deleting}
        onClose={() => setDeleting(false)}
        onConfirm={remove}
        danger
        title={`Delete this ${entity}?`}
        description="This cannot be undone."
        confirmLabel="Delete"
      />
    </Drawer>
  );
}

function renderFieldValue(field, record) {
  const value = record[field.key];
  if (field.type === 'relation') return record[field.displayKey ?? `${field.key.replace(/_id$/, '')}_name`] ?? (value ? '—' : null);
  if (field.type === 'select') return field.options.find((o) => o.value === value)?.label ?? (value ? titleCase(value) : null);
  if (field.type === 'money') return value !== null && value !== undefined ? money(value) : null;
  if (field.type === 'number') return value !== null && value !== undefined && value !== '' ? Number(value).toLocaleString('en-IN', { maximumFractionDigits: 3 }) : null;
  if (field.type === 'date') return value ? fmtDate(value) : null;
  if (field.type === 'checkbox') return value ? 'Yes' : 'No';
  if (field.type === 'checklist') return value?.length ? <ul className="list-disc pl-5">{value.map((p, i) => <li key={i}>{p.label}</li>)}</ul> : null;
  if (field.type === 'person') return record[field.displayKey ?? `${field.key.replace(/_id$/, '')}_name`] ?? (value ? 'A teammate' : null);
  return value === '' ? null : value;
}

/* ── the form ─────────────────────────────────────────────────────────────── */

export function RecordForm({ endpoint, entity, fields, record, toForm, fromForm, onClose, onSaved, title }) {
  const isNew = !record.id;
  const initial = useMemo(() => {
    const base = {};
    for (const f of fields) {
      const value = record[f.key];
      if (f.type === 'checkbox') base[f.key] = value ?? f.default ?? false;
      else if (f.type === 'checklist') base[f.key] = value ?? [];
      else if (f.type === 'date') base[f.key] = value ? String(value).slice(0, 10) : '';
      else base[f.key] = value === null || value === undefined ? (f.default ?? '') : String(value);
    }
    return toForm ? toForm(base, record) : base;
  }, [fields, record, toForm]);

  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  async function submit(event) {
    event?.preventDefault();
    setBusy(true);
    setErrors({});
    setFormError(null);
    const payload = {};
    for (const f of fields) {
      if (f.readOnly || (f.createOnly && !isNew)) continue;
      const raw = form[f.key];
      if (f.type === 'checkbox') payload[f.key] = Boolean(raw);
      else if (f.type === 'checklist') payload[f.key] = raw.filter((p) => p.label?.trim()).map((p) => ({ label: p.label.trim() }));
      else if (raw === '' || raw === undefined) { if (!isNew || f.required) payload[f.key] = f.required ? raw : null; }
      else if (f.type === 'number') payload[f.key] = Number(raw);
      else if (f.type === 'money') payload[f.key] = Number(raw).toFixed(2);
      else payload[f.key] = raw;
    }
    const body = fromForm ? fromForm(payload, form, record) : payload;
    try {
      const response = isNew ? await api.post(endpoint, body) : await api.patch(`${endpoint}/${record.id}`, body);
      onClose();
      onSaved(response.data, isNew);
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fieldErrors).length) setErrors(err.fieldErrors);
      else setFormError(err instanceof ApiError ? err.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }

  const visible = fields.filter((f) => !f.readOnly && !(f.createOnly && !isNew) && !(f.showIf && !f.showIf(form)));

  return (
    <Modal
      open
      onClose={onClose}
      title={title ?? (isNew ? `New ${entity}` : `Edit ${entity}`)}
      size={visible.length > 6 ? 'xl' : 'lg'}
      footer={<><Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" loading={busy} onClick={submit}>{isNew ? 'Create' : 'Save'}</Button></>}
    >
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        {formError && <Alert tone="critical" className="sm:col-span-2">{formError}</Alert>}
        {visible.map((f, index) => (
          <FormField key={f.key} field={f} value={form[f.key]} error={errors[f.key]} onChange={(v) => set(f.key, v)} autoFocus={index === 0} />
        ))}
      </form>
    </Modal>
  );
}

function FormField({ field: f, value, error, onChange, autoFocus }) {
  const full = f.full || ['textarea', 'checklist'].includes(f.type) ? 'sm:col-span-2' : undefined;
  if (f.type === 'checkbox') {
    return <Checkbox className={full ?? 'sm:col-span-2'} label={f.label} description={f.hint} checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />;
  }
  if (f.type === 'checklist') return <ChecklistField field={f} value={value} onChange={onChange} error={error} />;
  return (
    <Field label={f.label} required={f.required} hint={f.hint} error={error} className={full}>
      {(p) => {
        const common = { ...p, value: value ?? '', onChange: (e) => onChange(e.target.value), ...(autoFocus ? { 'data-autofocus': true } : {}), placeholder: f.placeholder };
        if (f.type === 'textarea') return <Textarea {...common} rows={f.rows ?? 3} />;
        if (f.type === 'select') {
          return (
            <Select {...common}>
              {!f.required && <option value="">{f.emptyLabel ?? '—'}</option>}
              {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Select>
          );
        }
        if (f.type === 'relation' || f.type === 'person') return <RelationSelect field={f} common={common} />;
        const type = { number: 'number', money: 'number', date: 'date', email: 'email', url: 'url' }[f.type] ?? 'text';
        return <Input {...common} type={type} min={f.min ?? (['number', 'money'].includes(f.type) ? 0 : undefined)} step={f.step ?? (f.type === 'money' ? '0.01' : f.type === 'number' ? 'any' : undefined)} />;
      }}
    </Field>
  );
}

/** A select whose options come from the API: products, vendors, people. */
function RelationSelect({ field: f, common }) {
  const { can } = useWorkspace();
  const endpoint = f.type === 'person' ? (f.endpoint ?? '/members') : f.endpoint;
  const allowed = f.type !== 'person' || f.endpoint || can('core.members.view');
  const options = useOptions(allowed ? endpoint : null, f.query ?? (f.type === 'person' ? { status: 'active', limit: 100 } : { limit: 100 }));
  const valueKey = f.valueKey ?? (f.type === 'person' ? 'user_id' : 'id');
  const labelOf = f.labelOf ?? ((o) => o[f.labelKey ?? 'name'] ?? o.email ?? o.id);
  return (
    <Select {...common}>
      <option value="">{f.emptyLabel ?? (f.required ? 'Choose…' : '—')}</option>
      {options.map((o) => <option key={o[valueKey]} value={o[valueKey]}>{labelOf(o)}</option>)}
    </Select>
  );
}

const optionCache = new Map();
/** Load a short option list once per page; cached across forms. */
export function useOptions(endpoint, query = { limit: 100 }) {
  const key = endpoint ? `${endpoint}?${JSON.stringify(query)}` : null;
  const [options, setOptions] = useState(() => (key && optionCache.get(key)) || []);
  useEffect(() => {
    if (!key) return undefined;
    let live = true;
    // Keys starting with _ only bust the cache; they are not sent.
    const sent = Object.fromEntries(Object.entries(query).filter(([k]) => !k.startsWith('_')));
    api.get(endpoint, { query: sent }).then((r) => {
      optionCache.set(key, r.data ?? []);
      if (live) setOptions(r.data ?? []);
    }).catch(() => {});
    return () => { live = false; };
  }, [key]);
  return options;
}
/** Forget cached option lists after something new was created. */
export const clearOptionCache = () => optionCache.clear();

function ChecklistField({ field: f, value = [], onChange, error }) {
  const items = value.length ? value : [{ label: '' }];
  const update = (index, label) => onChange(items.map((p, i) => (i === index ? { label } : p)));
  return (
    <div className="space-y-2 sm:col-span-2">
      <p className="text-sm font-medium">{f.label}</p>
      {items.map((p, index) => (
        <div key={index} className="flex gap-2">
          <Input value={p.label} onChange={(e) => update(index, e.target.value)} placeholder={f.placeholder ?? 'What to check'} className="flex-1" aria-label={`${f.label} ${index + 1}`} />
          <Button type="button" variant="ghost" size="icon-sm" icon={Trash2} aria-label="Remove" onClick={() => onChange(items.filter((_, i) => i !== index))} />
        </div>
      ))}
      <Button type="button" size="sm" variant="secondary" icon={Plus} onClick={() => onChange([...items, { label: '' }])}>Add</Button>
      {error && <p className="text-xs text-[var(--color-critical-600)]">{error}</p>}
    </div>
  );
}
