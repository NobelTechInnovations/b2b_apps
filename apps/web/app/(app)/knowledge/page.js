import { Suspense } from 'react';
import KnowledgeClient from './knowledge-client';

export const metadata = { title: 'Articles' };

export default function KnowledgePage() {
  return (
    <Suspense>
      <KnowledgeClient />
    </Suspense>
  );
}
