import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, MapPin, Briefcase, CalendarClock } from 'lucide-react';
import { publicApi } from '@/lib/public-api';
import { Markdown } from '@/components/data/markdown';
import { ApplyForm } from './apply-form';

const label = (v) => (v ? v.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : '');
const valid = (slug, jobId) => /^[a-z0-9-]{1,64}$/.test(slug) && /^job_[0-9a-z]{26}$/.test(jobId);

export async function generateMetadata({ params }) {
  const { slug, jobId } = await params;
  if (!valid(slug, jobId)) return { title: 'Careers' };
  const { data } = await publicApi(`/careers/${slug}/jobs/${jobId}`);
  return { title: data ? `${data.job.title} · ${data.organization.name}` : 'Careers' };
}

export default async function JobPage({ params }) {
  const { slug, jobId } = await params;
  if (!valid(slug, jobId)) notFound();
  const { data, status } = await publicApi(`/careers/${slug}/jobs/${jobId}`);
  if (status === 404) notFound();
  if (!data) return <p className="text-center text-[var(--text-secondary)]">This role is unavailable right now. Please try again in a minute.</p>;

  const { organization, job } = data;
  return (
    <div className="mx-auto grid w-full max-w-5xl gap-8 lg:grid-cols-[1fr_24rem]">
      <article>
        <Link href={`/careers/${organization.slug}`} className="inline-flex items-center gap-1 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
          <ArrowLeft className="size-3.5" /> All roles at {organization.name}
        </Link>
        <h1 className="mt-3 text-3xl font-semibold tracking-[-0.03em]">{job.title}</h1>
        <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-[var(--text-secondary)]">
          {job.department_name && <span>{job.department_name}</span>}
          {job.location && <span className="inline-flex items-center gap-1"><MapPin className="size-3.5" />{job.location}</span>}
          <span className="inline-flex items-center gap-1"><Briefcase className="size-3.5" />{label(job.employment_type)}</span>
          {job.salary_range && <span>{job.salary_range}</span>}
          {job.closes_on && <span className="inline-flex items-center gap-1"><CalendarClock className="size-3.5" />Apply by {new Date(job.closes_on).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</span>}
        </p>
        <div className="mt-6">
          {job.description ? <Markdown>{job.description}</Markdown> : <p className="text-[var(--text-secondary)]">Tell us about yourself — the team will be in touch.</p>}
        </div>
      </article>
      <aside className="panel h-fit p-6 lg:sticky lg:top-8">
        <h2 className="text-md font-semibold">Apply for this role</h2>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">No account needed. {organization.name} will contact you.</p>
        <div className="mt-5">
          <ApplyForm slug={organization.slug} jobId={job.id} />
        </div>
      </aside>
    </div>
  );
}
