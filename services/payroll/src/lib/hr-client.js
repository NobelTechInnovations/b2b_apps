/**
 * Payroll's window into HR.
 *
 * Two reads, both over HTTP with the internal service token, both at the
 * moment a run is processed. Nothing is cached and nothing is stored except
 * the snapshot that lands on the payslip — which is the point: HR can rename
 * a department or retime a shift without rewriting last quarter's payslips.
 */
export function createHrClient({ baseUrl, serviceToken, logger, timeoutMs = 20_000 }) {
  async function get(path, params) {
    const url = new URL(path, baseUrl);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        headers: { 'x-nexus-service-token': serviceToken },
        signal: controller.signal,
      });

      const text = await response.text();
      const payload = text ? JSON.parse(text) : null;

      if (!response.ok) {
        const error = new Error(payload?.error?.message ?? `HR responded ${response.status}`);
        error.status = response.status;
        throw error;
      }

      return payload?.data ?? [];
    } catch (error) {
      logger?.error({ err: error, path }, 'HR read failed');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    employees: (orgId, { activeOn, employeeIds } = {}) =>
      get('/internal/employees', {
        org_id: orgId,
        active_on: activeOn,
        employee_ids: employeeIds?.join(','),
      }),

    attendance: (orgId, { from, to, employeeIds } = {}) =>
      get('/internal/attendance/summary', {
        org_id: orgId,
        from,
        to,
        employee_ids: employeeIds?.join(','),
      }),

    /**
     * Which employee is this login?
     *
     * Payroll serves a payslip to the person it belongs to without keeping its
     * own copy of the user→employee mapping — HR owns that, as it owns the
     * employee record itself.
     */
    employeeForUser: (orgId, userId) =>
      get(`/internal/employees/by-user/${encodeURIComponent(userId)}`, { org_id: orgId }),
  };
}
