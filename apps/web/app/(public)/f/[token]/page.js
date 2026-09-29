import { notFound } from 'next/navigation';
import { publicApi } from '@/lib/public-api';
import { PublicForm } from '@/components/forms/public-form';

export async function generateMetadata({ params }) {
  const { token } = await params;
  const { data } = await publicApi(`/public-forms/${encodeURIComponent(token)}`);
  return { title: data?.name ?? 'Form', robots: { index: false } };
}

export default async function PublicFormPage({ params }) {
  const { token } = await params;
  if (!/^[A-Za-z0-9_-]{8,40}$/.test(token)) notFound();
  const { data, status } = await publicApi(`/public-forms/${token}`);
  if (status === 404 || (!data && status < 500)) notFound();
  if (!data) {
    return <p className="text-center text-[var(--text-secondary)]">This form is unavailable right now. Please try again in a minute.</p>;
  }

  return (
    <div className="panel mx-auto w-full max-w-xl p-6 sm:p-8">
      <h1 className="text-xl font-semibold tracking-[-0.02em]">{data.name}</h1>
      {data.description && <p className="mt-2 whitespace-pre-wrap text-[var(--text-secondary)]">{data.description}</p>}
      <div className="mt-6">
        <PublicForm form={data} token={token} />
      </div>
    </div>
  );
}
