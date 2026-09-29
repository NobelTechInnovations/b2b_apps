import Link from 'next/link';
import { notFound } from 'next/navigation';
import { MapPin, Briefcase, ArrowRight } from 'lucide-react';
import { publicApi } from '@/lib/public-api';

const label = (v) => (v ? v.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : '');
const valid = (slug) => /^[a-z0-9-]{1,64}$/.test(slug);

export async function generateMetadata({ params }) {
  const { slug } = await params;
  if (!valid(slug)) return { title: 'Careers' };
  const { data } = await publicApi(`/careers/${slug}`);
  return {
    title: data ? `Careers at ${data.organization.name}` : 'Careers',
    description: data ? `${data.jobs.length} open ${data.jobs.length === 1 ? 'role' : 'roles'} at ${data.organization.name}.` : undefined,
  };
}

export default async function CareersPage({ params }) {
  const { slug } = await params;
  if (!valid(slug)) notFound();
  const { data, status } = await publicApi(`/careers/${slug}`);
  if (status === 404) notFound();
  if (!data) return <p className="text-center text-[var(--text-secondary)]">Careers are unavailable right now. Please try again in a minute.</p>;

  const { organization, jobs } = data;
  return (
    <div className="mx-auto w-full max-w-3xl">
      <header className="mb-8 text-center">
        <p className="text-sm font-medium text-[var(--color-brand-600)]">Careers</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-[-0.03em]">Work at {organization.name}</h1>
        <p className="mt-2 text-[var(--text-secondary)]">
          {jobs.length ? `${jobs.length} open ${jobs.length === 1 ? 'role' : 'roles'}. Apply in two minutes — no account needed.` : 'No open roles right now. Check back soon.'}
        </p>
      </header>

      <ul className="space-y-3">
        {jobs.map((job) => (
          <li key={job.id}>
            <Link href={`/careers/${organization.slug}/jobs/${job.id}`} className="panel group block p-5 transition hover:border-[var(--border-strong)]">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <h2 className="text-md font-semibold group-hover:underline">{job.title}</h2>
                  <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-[var(--text-secondary)]">
                    {job.department_name && <span>{job.department_name}</span>}
                    {job.location && <span className="inline-flex items-center gap-1"><MapPin className="size-3.5" />{job.location}</span>}
                    <span className="inline-flex items-center gap-1"><Briefcase className="size-3.5" />{label(job.employment_type)}</span>
                    {job.salary_range && <span>{job.salary_range}</span>}
                  </p>
                  {job.summary && <p className="mt-2 line-clamp-2 text-sm text-[var(--text-tertiary)]">{job.summary.replace(/[#*_>`]/g, '')}</p>}
                </div>
                <ArrowRight className="mt-1 size-4 shrink-0 text-[var(--text-tertiary)] transition group-hover:translate-x-0.5" />
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
