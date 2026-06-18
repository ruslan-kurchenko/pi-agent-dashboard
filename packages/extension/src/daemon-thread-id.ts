/**
 * walle-multi-machine: read the wall-e thread id the launcher injects into a
 * dashboard-channel daemon container and produce the spread-field the bridge
 * sends with every `session_register`.
 *
 * Set in the wall-e launcher (`container-runner.ts`) only for sessions whose
 * channel is the dashboard channel:
 *
 *   PI_DASHBOARD_THREAD_ID — `session.thread_id` of the wall-e home agent
 *
 * The server persists it to `.meta.json` and onto
 * `DashboardSession.daemonThreadId` to drive the daemon "Continue" route.
 * Laptop/remote bridges, non-dashboard daemon task sessions, and single-
 * machine / upstream installs leave the env unset; the helper returns `{}`
 * and the bridge omits the field entirely (back-compat).
 *
 * Mirrors `walle-machine-fields.ts` (env-derived, spread at every register
 * site for restart-survival re-stamping). Pure function — no side effects,
 * no env mutation. Tested in `__tests__/daemon-thread-id.test.ts`.
 *
 * See change: walle-multi-machine.
 */
export interface DaemonThreadIdField {
  daemonThreadId?: string;
}

export function buildDaemonThreadIdField(env: NodeJS.ProcessEnv): DaemonThreadIdField {
  const id = typeof env.PI_DASHBOARD_THREAD_ID === "string" ? env.PI_DASHBOARD_THREAD_ID.trim() : "";
  if (!id) return {};
  return { daemonThreadId: id };
}
