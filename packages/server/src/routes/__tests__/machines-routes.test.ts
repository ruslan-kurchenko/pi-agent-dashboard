/**
 * Route tests for `GET/POST/DELETE /api/machines` + the
 * `machines_changed` WS broadcast.
 *
 * See change: walle-multi-machine.
 *
 * Strategy: pre-seed `~/.pi/dashboard/config.json` under the per-file
 * HOME (provided by `setup-home-perfile.ts`) so `loadConfig()` returns the
 * fixture we want, then drive the routes through `fastify.inject`. The
 * broadcast helper is captured with an array spy so we can assert the
 * exact frames emitted.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import type { MachineEntry } from "@blackbelt-technology/pi-dashboard-shared/config.js";
import type {
  ListMachinesResponse,
  MachineRosterEntry,
  MachinesChangedMessage,
} from "@blackbelt-technology/pi-dashboard-shared/rest-api.js";
import type { SessionManager } from "../../memory-session-manager.js";
import {
  registerMachinesRoutes,
  computeRoster,
} from "../machines-routes.js";

const CONFIG_DIR = path.join(os.homedir(), ".pi", "dashboard");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

// Three curated machines mirror the in-tree wall-e roster (walle-daemon /
// arch-personal / mac-work) so the fixture exercises the same accents +
// roles the UI peer is wiring against.
const FIXTURE_MACHINES: MachineEntry[] = [
  {
    id: "walle-daemon",
    label: "Wall-E Daemon",
    accent: "#5fb4a4",
    role: "daemon",
    addedAt: "2026-06-01T00:00:00.000Z",
  },
  {
    id: "arch-personal",
    label: "Arch Personal",
    accent: "#f0a868",
    role: "laptop",
    addedAt: "2026-06-02T00:00:00.000Z",
  },
  {
    id: "mac-work",
    label: "Mac Work",
    accent: "#b9a3e8",
    role: "laptop",
    addedAt: "2026-06-03T00:00:00.000Z",
  },
];

function writeFixtureConfig(machines: MachineEntry[]): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ machines }, null, 2) + "\n");
}

function readDiskMachines(): MachineEntry[] {
  const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
  return JSON.parse(raw).machines as MachineEntry[];
}

function makeSession(overrides: Partial<DashboardSession> & { id: string }): DashboardSession {
  return {
    cwd: "/tmp/fixture",
    source: "tui",
    status: "active",
    startedAt: Date.now(),
    ...overrides,
  } as DashboardSession;
}

function fakeSessionManager(initial: DashboardSession[] = []): SessionManager {
  const map = new Map<string, DashboardSession>();
  for (const s of initial) map.set(s.id, s);
  return {
    register: () => { throw new Error("not used in tests"); },
    restore: (s) => { map.set(s.id, s); },
    unregister: (id) => {
      const s = map.get(id);
      if (s) { s.status = "ended"; s.endedAt = Date.now(); }
    },
    update: (id, updates) => {
      const s = map.get(id);
      if (s) Object.assign(s, updates);
    },
    get: (id) => map.get(id),
    listActive: () => Array.from(map.values()).filter((s) => s.status !== "ended"),
    listAll: () => Array.from(map.values()),
  };
}

async function makeApp(
  sessions: DashboardSession[] = [],
): Promise<{ app: FastifyInstance; broadcasts: MachinesChangedMessage[] }> {
  const app = Fastify({ logger: false });
  const broadcasts: MachinesChangedMessage[] = [];
  registerMachinesRoutes(app, {
    networkGuard: async () => undefined,
    sessionManager: fakeSessionManager(sessions),
    broadcast: (msg) => { broadcasts.push(msg); },
  });
  await app.ready();
  return { app, broadcasts };
}

describe("computeRoster (pure)", () => {
  it("flags walle-daemon online when a fresh-registered alive session points at it", () => {
    const now = Date.now();
    const roster = computeRoster(
      FIXTURE_MACHINES,
      [makeSession({
        id: "s1",
        status: "active",
        startedAt: now - 30_000, // 30s ago — well within the 5min window
        machine: { id: "walle-daemon" },
      })],
      now,
    );
    const walle = roster.find((m) => m.id === "walle-daemon")!;
    expect(walle.status).toBe("online");
    expect(walle.sessionCount).toBe(1);
    expect(walle.lastSeenAt).toBeDefined();
  });

  it("flags a machine idle when its last session is old but within 30min", () => {
    const now = Date.now();
    const roster = computeRoster(
      FIXTURE_MACHINES,
      [makeSession({
        id: "s2",
        status: "ended",
        startedAt: now - 20 * 60_000,
        lastActivityAt: now - 15 * 60_000, // 15min ago — outside online, inside idle
        endedAt: now - 14 * 60_000,
        machine: { id: "mac-work" },
      })],
      now,
    );
    const mac = roster.find((m) => m.id === "mac-work")!;
    expect(mac.status).toBe("idle");
    expect(mac.sessionCount).toBe(0);
  });

  it("flags offline when no session references the machine id", () => {
    const roster = computeRoster(FIXTURE_MACHINES, []);
    expect(roster.find((m) => m.id === "arch-personal")?.status).toBe("offline");
    expect(roster.find((m) => m.id === "arch-personal")?.sessionCount).toBe(0);
    expect(roster.find((m) => m.id === "arch-personal")?.lastSeenAt).toBeUndefined();
  });

  it("ignores sessions with no machine tag", () => {
    const now = Date.now();
    const roster = computeRoster(
      FIXTURE_MACHINES,
      [makeSession({ id: "untagged", status: "active", startedAt: now })],
      now,
    );
    for (const m of roster) expect(m.status).toBe("offline");
  });
});

describe("GET /api/machines", () => {
  let app: FastifyInstance;
  beforeEach(() => {
    writeFixtureConfig(FIXTURE_MACHINES);
  });
  afterEach(async () => {
    await app?.close();
  });

  it("returns the three configured machines from the fake config", async () => {
    ({ app } = await makeApp());
    const res = await app.inject({ method: "GET", url: "/api/machines" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ListMachinesResponse;
    expect(body.success).toBe(true);
    if (!body.success) return;
    const ids = body.data!.machines.map((m) => m.id);
    expect(ids).toEqual(["walle-daemon", "arch-personal", "mac-work"]);
  });

  it("tags walle-daemon online when a fresh-registered session matches", async () => {
    const now = Date.now();
    ({ app } = await makeApp([
      makeSession({
        id: "live",
        status: "active",
        startedAt: now - 1000,
        machine: { id: "walle-daemon" },
      }),
    ]));
    const res = await app.inject({ method: "GET", url: "/api/machines" });
    const body = res.json() as ListMachinesResponse;
    expect(body.success).toBe(true);
    if (!body.success) return;
    const walle = body.data!.machines.find((m) => m.id === "walle-daemon");
    expect(walle?.status).toBe("online");
    expect(walle?.sessionCount).toBe(1);
  });

  it("tags arch-personal offline when no session references it", async () => {
    ({ app } = await makeApp([
      makeSession({
        id: "elsewhere",
        status: "active",
        startedAt: Date.now(),
        machine: { id: "walle-daemon" },
      }),
    ]));
    const res = await app.inject({ method: "GET", url: "/api/machines" });
    const body = res.json() as ListMachinesResponse;
    expect(body.success).toBe(true);
    if (!body.success) return;
    const arch = body.data!.machines.find((m) => m.id === "arch-personal");
    expect(arch?.status).toBe("offline");
    expect(arch?.sessionCount).toBe(0);
    expect(arch?.lastSeenAt).toBeUndefined();
  });
});

describe("POST /api/machines", () => {
  let app: FastifyInstance;
  let broadcasts: MachinesChangedMessage[];
  beforeEach(() => {
    writeFixtureConfig(FIXTURE_MACHINES);
  });
  afterEach(async () => {
    await app?.close();
  });

  it("upserts a new entry, persists it to disk, and returns it as a roster entry", async () => {
    ({ app, broadcasts } = await makeApp());
    const res = await app.inject({
      method: "POST",
      url: "/api/machines",
      payload: {
        id: "extra-laptop",
        label: "Extra Laptop",
        accent: "#cccccc",
        role: "laptop",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { success: true; data: MachineRosterEntry };
    expect(body.success).toBe(true);
    expect(body.data.id).toBe("extra-laptop");
    expect(body.data.label).toBe("Extra Laptop");
    expect(body.data.status).toBe("offline"); // no sessions yet
    expect(body.data.addedAt).toBeDefined();

    const onDisk = readDiskMachines();
    expect(onDisk.map((m) => m.id)).toContain("extra-laptop");
    expect(onDisk.find((m) => m.id === "extra-laptop")?.accent).toBe("#cccccc");

    // Broadcast fired exactly once with the post-write roster
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].type).toBe("machines_changed");
    expect(broadcasts[0].machines.map((m) => m.id)).toContain("extra-laptop");
  });

  it("updates an existing entry without dropping curated metadata", async () => {
    ({ app } = await makeApp());
    const res = await app.inject({
      method: "POST",
      url: "/api/machines",
      payload: { id: "walle-daemon", label: "Wall-E (renamed)" },
    });
    expect(res.statusCode).toBe(200);
    const onDisk = readDiskMachines();
    const walle = onDisk.find((m) => m.id === "walle-daemon")!;
    expect(walle.label).toBe("Wall-E (renamed)");
    // accent / role / addedAt from the fixture survive the partial body
    expect(walle.accent).toBe("#5fb4a4");
    expect(walle.role).toBe("daemon");
    expect(walle.addedAt).toBe("2026-06-01T00:00:00.000Z");
  });

  it("returns 400 on a malformed JSON body, not 500", async () => {
    ({ app } = await makeApp());
    const res = await app.inject({
      method: "POST",
      url: "/api/machines",
      headers: { "content-type": "application/json" },
      payload: "{ this is not json",
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when id is missing or non-string", async () => {
    ({ app } = await makeApp());
    const res = await app.inject({
      method: "POST",
      url: "/api/machines",
      payload: { label: "no-id" },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { success: false; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/id/i);
  });

  it("returns 400 when id is a traversal-shaped string", async () => {
    ({ app } = await makeApp());
    const res = await app.inject({
      method: "POST",
      url: "/api/machines",
      payload: { id: "../etc/passwd", label: "evil" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when label is missing or blank", async () => {
    ({ app } = await makeApp());
    const res = await app.inject({
      method: "POST",
      url: "/api/machines",
      payload: { id: "blanks", label: "   " },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("DELETE /api/machines/:id", () => {
  let app: FastifyInstance;
  let broadcasts: MachinesChangedMessage[];
  beforeEach(() => {
    writeFixtureConfig(FIXTURE_MACHINES);
  });
  afterEach(async () => {
    await app?.close();
  });

  it("removes the entry and a subsequent GET no longer lists it", async () => {
    ({ app, broadcasts } = await makeApp());
    const del = await app.inject({ method: "DELETE", url: "/api/machines/mac-work" });
    expect(del.statusCode).toBe(204);

    const onDisk = readDiskMachines();
    expect(onDisk.map((m) => m.id)).toEqual(["walle-daemon", "arch-personal"]);

    const list = await app.inject({ method: "GET", url: "/api/machines" });
    const body = list.json() as ListMachinesResponse;
    expect(body.success).toBe(true);
    if (!body.success) return;
    expect(body.data!.machines.map((m) => m.id)).not.toContain("mac-work");

    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].machines.map((m) => m.id)).not.toContain("mac-work");
  });

  it("returns 404 when the id is unknown (no broadcast fired)", async () => {
    ({ app, broadcasts } = await makeApp());
    const res = await app.inject({ method: "DELETE", url: "/api/machines/no-such" });
    expect(res.statusCode).toBe(404);
    expect(broadcasts).toHaveLength(0);
  });

  it("returns 400 on a malformed id (e.g. path-traversal-shaped slug)", async () => {
    ({ app, broadcasts } = await makeApp());
    // Use an encoded slash so Fastify's matcher routes it as `:id` rather
    // than 404'ing on a multi-segment path before we get to validate.
    const res = await app.inject({
      method: "DELETE",
      url: `/api/machines/${encodeURIComponent("../passwd")}`,
    });
    expect(res.statusCode).toBe(400);
    expect(broadcasts).toHaveLength(0);
  });
});
