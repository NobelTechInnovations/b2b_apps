import { Suspense } from 'react';
import PipelineClient from './pipeline-client';

export const metadata = { title: 'Pipeline' };

export default function RecruitmentPipelinePage() {
  return (
    <Suspense>
      <PipelineClient />
    </Suspense>
  );
}
