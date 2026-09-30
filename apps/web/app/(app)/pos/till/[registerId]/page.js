import TillClient from './till-client';

export const metadata = { title: 'Till' };

export default async function TillPage({ params }) {
  const { registerId } = await params;
  return <TillClient registerId={registerId} />;
}
