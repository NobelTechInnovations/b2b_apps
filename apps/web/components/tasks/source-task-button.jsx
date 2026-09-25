 'use client';
import Link from 'next/link';
import { ListChecks } from 'lucide-react';
import { useWorkspace } from '@/lib/workspace';
import { Button } from '@/components/ui/button';
export function SourceTaskButton({ app, type, recordId, title }) {
  const { can, workspace } = useWorkspace();
  if (!can('tasks.tasks.create') || !workspace?.installed?.includes('tasks') || !workspace?.apps?.includes('tasks')) return null;
  const query = new URLSearchParams({ create: '1', source_app: app, source_type: type, source_id: recordId, title });
  return <Link href={`/tasks?${query}`}><Button size="sm" icon={ListChecks}>Create task</Button></Link>;
}
