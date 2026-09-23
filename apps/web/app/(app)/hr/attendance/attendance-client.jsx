'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  UserCheck, UserX, CalendarOff, Laptop, CircleDashed, LogIn, LogOut, Users,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { date } from '@/lib/format';
import { Can, useWorkspace } from '@/lib/workspace';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { StatTile } from '@/components/data/stat-tile';
import { Avatar, Badge, Card, EmptyState, PageHeader, Alert, Skeleton } from '@/components/ui/primitives';

const STATUS = {
  present:    { label: 'Present',    tone: 'positive', icon: UserCheck },
  remote:     { label: 'Remote',     tone: 'info',     icon: Laptop },
  on_leave:   { label: 'On leave',   tone: 'caution',  icon: CalendarOff },
  absent:     { label: 'Absent',     tone: 'critical', icon: UserX },
  half_day:   { label: 'Half day',   tone: 'caution',  icon: CircleDashed },
  holiday:    { label: 'Holiday',    tone: 'neutral',  icon: CalendarOff },
  weekend:    { label: 'Weekend',    tone: 'neutral',  icon: CalendarOff },
  not_marked: { label: 'Not marked', tone: 'neutral',  icon: CircleDashed },
};

const time = (value) =>
  value ? new Date(value).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }) : '—';

export default function AttendanceClient() {
  const toast = useToast();
  const { can } = useWorkspace();

  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState(null);
  const [departments, setDepartments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [onDate, setOnDate] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.get('/hr/attendance/today', {
        query: { on_date: onDate || undefined, department_id: departmentId || undefined },
      });
      setRows(response.data);
      setMeta(response.meta);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load attendance.');
    } finally {
      setLoading(false);
    }
  }, [onDate, departmentId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    api.get('/hr/departments').then((r) => setDepartments(r.data)).catch(() => setDepartments([]));
  }, []);

  const isToday = !onDate || onDate === new Date().toISOString().slice(0, 10);

  async function mark(employeeId, status) {
    setBusyId(employeeId);
    try {
      await api.post('/hr/attendance', { employee_id: employeeId, status, on_date: onDate || undefined });
      await load();
    } catch (err) {
      toast.error('Could not save that', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setBusyId(null);
    }
  }

  async function punch(employeeId, direction) {
    setBusyId(employeeId);
    try {
      await api.post(`/hr/attendance/check-${direction}`, { employee_id: employeeId });
      toast.success(direction === 'in' ? 'Checked in' : 'Checked out');
      await load();
    } catch (err) {
      toast.error(`Could not check ${direction}`, {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setBusyId(null);
    }
  }

  const counts = meta?.counts;
  const total = meta?.total ?? 0;
  const rate = total > 0 ? Math.round(((counts?.present ?? 0) + (counts?.remote ?? 0)) / total * 100) : 0;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Attendance"
        description={isToday ? 'Who is in today.' : `Attendance for ${date(onDate)}.`}
        actions={
          <div className="flex items-center gap-2">
            <Select
              value={departmentId}
              onChange={(e) => setDepartmentId(e.target.value)}
              className="w-auto min-w-[10rem]"
              aria-label="Department"
            >
              <option value="">All departments</option>
              {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </Select>
            <Input
              type="date"
              value={onDate}
              onChange={(e) => setOnDate(e.target.value)}
              className="w-auto"
              aria-label="Date"
            />
          </div>
        }
      />

      {counts && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
          <StatTile label="In" value={(counts.present ?? 0) + (counts.remote ?? 0)}
            icon={UserCheck} tone="positive" hint={`${rate}% of ${total}`} />
          <StatTile label="Remote" value={counts.remote ?? 0} icon={Laptop} />
          <StatTile label="On leave" value={counts.on_leave ?? 0} icon={CalendarOff} />
          <StatTile label="Absent" value={counts.absent ?? 0} icon={UserX}
            tone={(counts.absent ?? 0) > 0 ? 'critical' : 'neutral'} />
          <StatTile label="Not marked" value={counts.not_marked ?? 0} icon={CircleDashed}
            tone={(counts.not_marked ?? 0) > 0 ? 'caution' : 'neutral'} />
        </div>
      )}

      {error && <Alert tone="critical">{error}</Alert>}

      {loading ? (
        <div className="space-y-2">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={Users}
            title="Nobody to show"
            description="Add employees before you can record attendance."
          />
        </Card>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => {
            const status = STATUS[row.status] ?? STATUS.not_marked;
            const busy = busyId === row.employee_id;
            const locked = row.status === 'on_leave';

            return (
              <div key={row.employee_id} className="panel flex flex-wrap items-center gap-3 p-3.5">
                <Avatar name={row.name} size="md" />

                <div className="min-w-0 flex-1">
                  <p className="truncate text-base font-medium">{row.name}</p>
                  <p className="truncate text-xs text-[var(--text-tertiary)]">
                    {row.employee_code}
                    {row.designation ? ` · ${row.designation}` : ''}
                    {row.department_name ? ` · ${row.department_name}` : ''}
                  </p>
                </div>

                <div className="hidden items-center gap-4 text-xs tabular text-[var(--text-secondary)] sm:flex">
                  <span>In {time(row.check_in_at)}</span>
                  <span>Out {time(row.check_out_at)}</span>
                  {row.work_minutes != null && (
                    <span className="font-medium text-[var(--text-primary)]">
                      {Math.floor(row.work_minutes / 60)}h {row.work_minutes % 60}m
                    </span>
                  )}
                </div>

                <Badge size="sm" tone={status.tone} dot>{status.label}</Badge>

                <Can permission="hr.attendance.edit">
                  <div className="flex items-center gap-1">
                    {isToday && !locked && !row.check_in_at && (
                      <Button variant="secondary" size="sm" icon={LogIn} loading={busy}
                        onClick={() => punch(row.employee_id, 'in')}>
                        Check in
                      </Button>
                    )}
                    {isToday && !locked && row.check_in_at && !row.check_out_at && (
                      <Button variant="secondary" size="sm" icon={LogOut} loading={busy}
                        onClick={() => punch(row.employee_id, 'out')}>
                        Check out
                      </Button>
                    )}
                    {!locked && (
                      <Select
                        value={row.status === 'not_marked' ? '' : row.status}
                        onChange={(e) => e.target.value && mark(row.employee_id, e.target.value)}
                        disabled={busy}
                        className="w-auto min-w-[8.5rem]"
                        aria-label={`Set status for ${row.name}`}
                      >
                        <option value="">Set status…</option>
                        {['present', 'remote', 'half_day', 'absent', 'holiday'].map((s) => (
                          <option key={s} value={s}>{STATUS[s].label}</option>
                        ))}
                      </Select>
                    )}
                    {locked && (
                      <span className="text-xs text-[var(--text-tertiary)]">Approved leave</span>
                    )}
                  </div>
                </Can>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
