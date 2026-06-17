/**
 * REST routes for the multi-machine roster (`/api/machines`).
 *
 * Wire-protocol: see `MachineRosterEntry` + `MachinesChangedMessage` in
 * `@blackbelt-technology/pi-dashboard-shared/rest-api.js`.
 *
 * The roster is the small subset of `DashboardConfig.machines` that the
 * sidebar needs to render chips + status dots. Liveness is recomputed
 * from `sessionManager.listAll()` on every read; nothing about machine
 * status is persisted on disk.
 *
 * Persistence model mirrors `known-servers-routes.ts`:
 *   - `loadConfig()` → in-memory `DashboardConfig`
 *   - `writeConfigPartial({ machines })` → atomic write of the full list
 *
 * Auth: every endpoint is gated by the same `networkGuard` preHandler used
 * by `/api/known-servers` (and friends), so trusted-network rules apply
 * uniformly to reads and writes.
 *
 * See change: walle-multi-machine.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import type { NetworkGuard } from "./route-deps.js";
import type { SessionManager } from "../memory-session-manager.js";
import type { ApiResponse, DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import type { MachineEntry } from "@blackbelt-technology/pi-dashboard-shared/config.js";
import type {
  MachineRosterEntry,
  ListMachinesResponse,
  MachinesChangedMessage,
} from "@blackbelt-technology/pi-dashboard-shared/rest-api.js";
import { loadConfig } from "@blackbelt-technology/pi-dashboard-shared/config.js";
import { writeConfigPartial } from "../config-api.js";

const ONLINE_WINDOW_MS = 5 * 60 * 1000;
const IDLE_WINDOW_MS = 30 * 60 * 1000;

/**
 * Same kebab-slug shape the wall-e installer mints (`walle-daemon`,
 * `arch-personal`, etc.). Doubles as the URL segment for `DELETE
 * /api/machines/:id`, so blocking `.`, `/`, and `%` here is what defends
 * the on-disk config against path-traversal-style payloads.
 */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Pure: derive the roster + liveness from a config snapshot and the
 * session list at a single point in time. Sessions are bucketed by
 * `machine.id` once; per-entry work is O(buckets). Exported for tests.
 */
export function computeRoster(
  machines: readonly MachineEntry[],
  sessions: readonly DashboardSession[],
  now: number = Date.now(),
): MachineRosterEntry[] {
  const byMachine = new Map<string, DashboardSession[]>();
  for (const s of sessions) {
    const id = s.machine?.id;
    if (!id) continue;
    const bucket = byMachine.get(id);
    if (bucket) bucket.push(s);
    else byMachine.set(id, [s]);
  }

  return machines.map((m) => {
    const matched = byMachine.get(m.id) ?? [];
    let aliveCount = 0;
    let hasFreshRegister = false;
    let lastSeen = 0;
    for (const s of matched) {
      const alive = s.status !== "ended";
      if (alive) {
        aliveCount += 1;
        if (now - s.startedAt < ONLINE_WINDOW_MS) hasFreshRegister = true;
      }
      const seen = s.lastActivityAt ?? s.startedAt;
      if (seen > lastSeen) lastSeen = seen;
    }

    let status: MachineRosterEntry["status"] = "offline";
    if (hasFreshRegister) status = "online";
    else if (lastSeen > 0 && now - lastSeen < IDLE_WINDOW_MS) status = "idle";

    const entry: MachineRosterEntry = {
      ...m,
      status,
      sessionCount: aliveCount,
    };
    if (lastSeen > 0) entry.lastSeenAt = new Date(lastSeen).toISOString();
    return entry;
  });
}

/**
 * Validate + normalise a POST body into a writable `MachineEntry`.
 * `existing` (when present) supplies fallback values for every optional
 * field the body omits, so a partial update never drops curated metadata
 * (accents, owner, bridge hash, …). On success returns `{ entry }`; on
 * any structural defect returns `{ error }` with the 400-message text.
 */
function normalizeUpsertBody(
  body: unknown,
  existing: MachineEntry | undefined,
): { entry: MachineEntry } | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "body must be a MachineEntry object" };
  }
  const b = body as Record<string, unknown>;

  if (typeof b.id !== "string" || !ID_PATTERN.test(b.id)) {
    return { error: "invalid id (expect kebab-case slug, ≤64 chars)" };
  }
  if (typeof b.label !== "string" || !b.label.trim()) {
    return { error: "label is required" };
  }

  const pickString = (key: string): string | undefined => {
    if (b[key] === undefined) return existing?.[key as keyof MachineEntry] as string | undefined;
    if (b[key] === null || b[key] === "") return undefined;
    if (typeof b[key] !== "string") return undefined;
    return b[key] as string;
  };
  const pickNumber = (key: string): number | undefined => {
    if (b[key] === undefined) return existing?.[key as keyof MachineEntry] as number | undefined;
    if (b[key] === null) return undefined;
    if (typeof b[key] !== "number" || !Number.isFinite(b[key])) return undefined;
    return b[key] as number;
  };

  const entry: MachineEntry = {
    id: b.id,
    label: b.label.trim(),
    addedAt: existing?.addedAt
      ?? (typeof b.addedAt === "string" ? b.addedAt : new Date().toISOString()),
  };
  const accent = pickString("accent");
  if (accent !== undefined) entry.accent = accent;
  const role = pickString("role");
  if (role !== undefined) entry.role = role;
  const host = pickString("host");
  if (host !== undefined) entry.host = host;
  const port = pickNumber("port");
  if (port !== undefined) entry.port = port;
  const piPort = pickNumber("piPort");
  if (piPort !== undefined) entry.piPort = piPort;
  const bridgeTokenHash = pickString("bridgeTokenHash");
  if (bridgeTokenHash !== undefined) entry.bridgeTokenHash = bridgeTokenHash;
  const owner = pickString("owner");
  if (owner !== undefined) entry.owner = owner;
  return { entry };
}

export interface MachinesRoutesDeps {
  networkGuard: NetworkGuard;
  sessionManager: SessionManager;
  /**
   * Broadcast a `machines_changed` frame to every dashboard client.
   * Wired in `server.ts` to `browserGateway.broadcastToAll`; tests
   * pass a spy.
   */
  broadcast: (msg: MachinesChangedMessage) => void;
}

export function registerMachinesRoutes(
  fastify: FastifyInstance,
  deps: MachinesRoutesDeps,
): void {
  const { networkGuard, sessionManager, broadcast } = deps;

  function currentRoster(): MachineRosterEntry[] {
    const cfg = loadConfig();
    return computeRoster(cfg.machines, sessionManager.listAll());
  }

  function broadcastMachinesChanged(): MachineRosterEntry[] {
    const machines = currentRoster();
    broadcast({ type: "machines_changed", machines });
    return machines;
  }

  fastify.get(
    "/api/machines",
    { preHandler: networkGuard },
    async (): Promise<ListMachinesResponse> => {
      return { success: true, data: { machines: currentRoster() } };
    },
  );

  fastify.post<{ Body: unknown }>(
    "/api/machines",
    { preHandler: networkGuard },
    async (request, reply): Promise<ApiResponse<MachineRosterEntry> | undefined> => {
      const cfg = loadConfig();
      const list = [...cfg.machines];
      const candidateId = typeof (request.body as { id?: unknown } | null)?.id === "string"
        ? ((request.body as { id: string }).id)
        : undefined;
      const existing = candidateId ? list.find((m) => m.id === candidateId) : undefined;

      const result = normalizeUpsertBody(request.body, existing);
      if ("error" in result) {
        reply.code(400);
        return { success: false, error: result.error };
      }

      const { entry } = result;
      const idx = list.findIndex((m) => m.id === entry.id);
      if (idx >= 0) list[idx] = entry;
      else list.push(entry);

      const write = writeConfigPartial({ machines: list });
      if (!write.success) {
        reply.code(500);
        return { success: false, error: write.error ?? "config write failed" };
      }

      const roster = broadcastMachinesChanged();
      const upserted = roster.find((m) => m.id === entry.id);
      // Fallback path is unreachable in practice (we just wrote the entry),
      // but keeps the type system honest without an `as` cast.
      return {
        success: true,
        data: upserted ?? { ...entry, status: "offline", sessionCount: 0 },
      };
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    "/api/machines/:id",
    { preHandler: networkGuard },
    async (request, reply): Promise<FastifyReply | ApiResponse> => {
      const { id } = request.params;
      if (typeof id !== "string" || !ID_PATTERN.test(id)) {
        reply.code(400);
        return { success: false, error: "invalid id (expect kebab-case slug, ≤64 chars)" };
      }

      const cfg = loadConfig();
      const filtered = cfg.machines.filter((m) => m.id !== id);
      if (filtered.length === cfg.machines.length) {
        reply.code(404);
        return { success: false, error: "machine not found" };
      }

      const write = writeConfigPartial({ machines: filtered });
      if (!write.success) {
        reply.code(500);
        return { success: false, error: write.error ?? "config write failed" };
      }

      broadcastMachinesChanged();
      return reply.code(204).send();
    },
  );
}
