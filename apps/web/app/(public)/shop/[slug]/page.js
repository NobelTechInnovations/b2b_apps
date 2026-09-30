import { notFound } from 'next/navigation';
import { publicApi } from '@/lib/public-api';
import ShopClient from './shop-client';

const valid = (slug) => /^[a-z0-9-]{1,64}$/.test(slug);

export async function generateMetadata({ params }) {
  const { slug } = await params;
  if (!valid(slug)) return { title: 'Shop' };
  const { data } = await publicApi(`/store/${slug}`);
  return { title: data ? data.store.name : 'Shop', description: data?.store.tagline || undefined };
}

export default async function ShopPage({ params }) {
  const { slug } = await params;
  if (!valid(slug)) notFound();
  const { data, status } = await publicApi(`/store/${slug}`);
  if (status === 404) notFound();
  if (!data) return <p className="text-center text-[var(--text-secondary)]">This store is unavailable right now. Please try again in a minute.</p>;
  return <ShopClient slug={slug} store={data.store} products={data.products} />;
}
