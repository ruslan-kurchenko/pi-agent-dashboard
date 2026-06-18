/**
 * walle-multi-machine: identify a daemon (WALL•E) session client-side.
 *
 * A daemon session IS the local machine in a wall-e deployment — the dashboard
 * server's `WALLE_MACHINE_ID` is the `walle-daemon` slug minted by the wall-e
 * installer. Such sessions are continued ONLY via the dashboard composer /
 * New Session inject transport (`/api/machines/<id>/message` → `/inject`),
 * NEVER via the host-local resume/spawn path (a bare `pi` on the daemon host
 * has no OneCLI proxy → 401).
 *
 * `role` is NOT carried on `DashboardSession.machine` ({ id, label?, accent? }
 * only) — it lives on the roster entry — so the robust session-level signal is
 * the daemon machine id. See change: walle-daemon-continue-honesty.
 */
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";

/** The kebab-slug the wall-e installer assigns to the daemon machine. */
export const DAEMON_MACHINE_ID = "walle-daemon";

/** True iff `session` belongs to the local WALL•E daemon machine. */
export function isDaemonSession(session: Pick<DashboardSession, "machine">): boolean {
  return session.machine?.id === DAEMON_MACHINE_ID;
}
