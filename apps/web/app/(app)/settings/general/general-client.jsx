'use client';

import { useState } from 'react';
import { Save } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Can } from '@/lib/workspace';
import { useToast } from '@/components/ui/toast';
import { Card, CardHeader, CardBody, CardFooter, PageHeader, Alert } from '@/components/ui/primitives';
import { Button } from '@/components/ui/button';
import { Input, Field, Select } from '@/components/ui/input';

const INDUSTRIES = [
  'Software & IT', 'Manufacturing', 'Retail & E-commerce', 'Professional services',
  'Healthcare', 'Education', 'Construction', 'Logistics', 'Hospitality',
  'Finance & Insurance', 'Media & Marketing', 'Other',
];

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export default function GeneralClient({ organization }) {
  const toast = useToast();
  const [form, setForm] = useState({
    name: organization?.name ?? '',
    legal_name: organization?.legal_name ?? '',
    website: organization?.website ?? '',
    industry: organization?.industry ?? '',
    tax_id: organization?.tax_id ?? '',
    timezone: organization?.timezone ?? 'Asia/Kolkata',
    fiscal_year_start: organization?.fiscal_year_start ?? 4,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const set = (key) => (event) =>
    setForm((f) => ({
      ...f,
      [key]: key === 'fiscal_year_start' ? Number(event.target.value) : event.target.value,
    }));

  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.patch('/organizations/current', form);
      toast.success('Workspace updated');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save those changes.');
    } finally {
      setBusy(false);
    }
  }

  if (!organization) {
    return <Alert tone="critical">We could not load this workspace.</Alert>;
  }

  return (
    <div className="max-w-2xl">
      <PageHeader title="General" description="Details about your organization." />

      {error && <Alert tone="critical" className="mb-4">{error}</Alert>}

      <form onSubmit={save}>
        <Card>
          <CardHeader title="Organization" description="Shown to everyone in the workspace." />
          <CardBody className="space-y-4">
            <Field label="Workspace name" required>
              {(props) => <Input {...props} value={form.name} onChange={set('name')} required />}
            </Field>

            <Field label="Legal name" hint="Used on invoices and documents, if different.">
              {(props) => <Input {...props} value={form.legal_name} onChange={set('legal_name')} />}
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Website">
                {(props) => (
                  <Input {...props} placeholder="https://acme.in" value={form.website} onChange={set('website')} />
                )}
              </Field>
              <Field label="Industry">
                {(props) => (
                  <Select {...props} value={form.industry} onChange={set('industry')}>
                    <option value="">Not set</option>
                    {INDUSTRIES.map((industry) => (
                      <option key={industry} value={industry}>{industry}</option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="GSTIN / Tax ID">
                {(props) => (
                  <Input {...props} placeholder="27AAAAA0000A1Z5" value={form.tax_id} onChange={set('tax_id')} />
                )}
              </Field>
              <Field label="Financial year starts" hint="Drives reporting periods in Accounting.">
                {(props) => (
                  <Select {...props} value={form.fiscal_year_start} onChange={set('fiscal_year_start')}>
                    {MONTHS.map((month, index) => (
                      <option key={month} value={index + 1}>{month}</option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Workspace address" hint="Your unique URL. Not editable yet.">
                {(props) => <Input {...props} value={`${organization.slug}.nexus.app`} disabled />}
              </Field>
              <Field label="Currency" hint="Set at creation and used across all apps.">
                {(props) => <Input {...props} value={organization.currency} disabled />}
              </Field>
            </div>
          </CardBody>
          <CardFooter>
            <Can
              permission="core.settings.manage"
              fallback={
                <p className="text-xs text-[var(--text-tertiary)]">
                  Only an owner or admin can change these.
                </p>
              }
            >
              <Button type="submit" variant="primary" icon={Save} loading={busy}>
                Save changes
              </Button>
            </Can>
          </CardFooter>
        </Card>
      </form>
    </div>
  );
}
