'use client';

import { useState } from 'react';
import { Shield, Lock, Users, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Can } from '@/lib/workspace';
import { Card, Badge, PageHeader, EmptyState } from '@/components/ui/primitives';
import { Button } from '@/components/ui/button';
import { Icon, tintFor } from '@/components/shell/icon';

/**
 * Roles are bundles of permissions. Only permissions belonging to apps the
 * workspace actually has appear here — buying HR is what makes HR permissions
 * grantable in the first place.
 */
export default function RolesClient({ roles, permissionGroups }) {
  const [selected, setSelected] = useState(roles[0]?.id ?? null);
  const role = roles.find((r) => r.id === selected);

  const held = new Set(role?.permissions ?? []);
  const everything = role?.implicit_all;

  return (
    <div>
      <PageHeader
        title="Roles & permissions"
        description="Control what each group of people can see and change, app by app."
        actions={
          <Can permission="core.roles.manage">
            <Button variant="primary" icon={Shield}>Create a role</Button>
          </Can>
        }
      />

      <div className="grid gap-5 lg:grid-cols-[240px_1fr]">
        <div className="space-y-1">
          {roles.map((r) => (
            <button
              key={r.id}
              onClick={() => setSelected(r.id)}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-[var(--radius-lg)] border px-3 py-2.5 text-left transition-colors',
                selected === r.id
                  ? 'border-[var(--color-brand-500)] bg-[var(--color-brand-50)] dark:bg-[rgb(99_102_241/0.08)]'
                  : 'border-[var(--border-subtle)] bg-[var(--surface-raised)] hover:bg-[var(--surface-hover)]',
              )}
            >
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 truncate text-base font-medium">
                  {r.name}
                  {r.is_protected && <Lock className="size-3 text-[var(--text-disabled)]" />}
                </p>
                <p className="mt-0.5 flex items-center gap-1 text-xs text-[var(--text-tertiary)]">
                  <Users className="size-3" />
                  {r.member_count} {r.member_count === 1 ? 'person' : 'people'}
                </p>
              </div>
              <ChevronRight className="size-4 shrink-0 text-[var(--text-disabled)]" />
            </button>
          ))}
        </div>

        <div>
          {!role ? (
            <Card>
              <EmptyState icon={Shield} title="Pick a role" description="Choose a role to see what it grants." />
            </Card>
          ) : (
            <Card>
              <div className="border-b border-[var(--border-subtle)] px-5 py-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="flex items-center gap-2 text-md font-semibold">
                      {role.name}
                      {role.is_system && <Badge size="sm" tone="neutral">Built in</Badge>}
                    </h2>
                    <p className="mt-0.5 text-sm text-[var(--text-secondary)]">{role.description}</p>
                  </div>
                  {!role.is_protected && (
                    <Can permission="core.roles.manage">
                      <Button variant="secondary" size="sm">Edit</Button>
                    </Can>
                  )}
                </div>
              </div>

              {everything ? (
                <div className="px-5 py-8 text-center">
                  <Shield className="mx-auto size-8 text-[var(--color-brand-500)]" strokeWidth={1.5} />
                  <p className="mt-3 text-base font-medium">Full access to everything</p>
                  <p className="mt-1 text-sm text-[var(--text-secondary)]">
                    Owners hold every permission in every app this workspace has, including billing.
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-[var(--border-subtle)]">
                  {permissionGroups.map((group) => (
                    <div key={group.app} className="px-5 py-4">
                      <div className="mb-3 flex items-center gap-2">
                        <span className={cn('flex size-6 items-center justify-center rounded-[var(--radius-sm)]', tintFor(group.color))}>
                          <Icon name={group.icon} className="size-3.5" strokeWidth={2} />
                        </span>
                        <h3 className="text-base font-medium">{group.name}</h3>
                      </div>

                      <div className="space-y-2">
                        {group.resources.map((resource) => (
                          <div key={resource.resource} className="flex flex-wrap items-center gap-2">
                            <span className="w-28 shrink-0 text-sm capitalize text-[var(--text-secondary)]">
                              {resource.resource}
                            </span>
                            <div className="flex flex-wrap gap-1.5">
                              {resource.actions.map(({ permission, action }) => (
                                <span
                                  key={permission}
                                  className={cn(
                                    'rounded-full px-2 py-0.5 text-2xs font-medium ring-1 ring-inset',
                                    held.has(permission)
                                      ? 'bg-[var(--color-positive-50)] text-[var(--color-positive-700)] ring-[rgb(16_185_129/0.25)] dark:bg-[rgb(16_185_129/0.12)] dark:text-[var(--color-positive-500)]'
                                      : 'bg-transparent text-[var(--text-disabled)] ring-[var(--border-subtle)]',
                                  )}
                                >
                                  {action}
                                </span>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}

                  {permissionGroups.length === 0 && (
                    <EmptyState
                      icon={Shield}
                      title="No apps installed yet"
                      description="Permissions appear here once this workspace has apps."
                    />
                  )}
                </div>
              )}
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
