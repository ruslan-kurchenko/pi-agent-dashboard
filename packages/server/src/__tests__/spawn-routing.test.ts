/**
 * walle-multi-machine: cross-machine spawn routing.
 *
 * Two halves under test:
 *
 *  1. `handleSpawnSession` branches on `msg.machineId`. When the id is
 *     unset OR matches `process.env.WALLE_MACHINE_ID`, the existing
 *     local-spawn path runs unchanged. When the id targets a remote
 *     machine, the handler looks up the bridge via
 *     `piGateway.findBridgeByMachineId`, sends a `spawn_on_machine`
 *     frame, and returns `spawn_result { success: true }` synchronously
 *     so the placeholder card stays put. When no bridge is connected
 *     for that id, the handler fails fast with `spawn_error`
 *     `MACHINE_OFFLINE` (no retry).
 *
 *  2. `createBridgeRegistry` is a tiny LIFO map of machineId → live
 *     bridge WebSockets. `find` prefers the most recently registered
 *     `OPEN` connection so a freshly-reconnected laptop preempts an
 *     older socket whose `close` event has not yet fired.
 *
 * The handler tests stub the gateway entirely. The registry tests use
 * fake `WebSocket`-shaped objects to drive register/unregister/find
 * without needing a real WebSocket server — the loopback-bypass in
 * `verifyBridgeUpgrade` would otherwise prevent us from attributing
 * a machineId to a test connection.
 *
 * See change: walle-multi-machine.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WebSocket } from "ws";
import type { WebSocket as WSType } from "ws";

// Mock everything the handler depends on so it never touches a real
// pi binary, real filesystem, or the real spawn watchdog.
vi.mock("../spawn-preflight.js", () => ({
  preflightSpawn: vi.fn().mockReturnValue({ ok: true, reasons: [] }),
}));
vi.mock("../spawn-register-watchdog.js", () => ({
  getSpawnRegisterWatchdog: vi.fn().mockReturnValue({ arm: vi.fn() }),
}));
vi.mock("../spawn-failure-log.js", () => ({
  appendSpawnFailure: vi.fn(),
}));
vi.mock("../process-manager.js", () => ({
  spawnPiSession: vi.fn(),
}));
vi.mock("@blackbelt-technology/pi-dashboard-shared/config.js", () => ({
  loadConfig: vi.fn().mockReturnValue({
    spawnStrategy: "headless" as const,
    spawnRegisterTimeoutMs: 30000,
  }),
}));
vi.mock("@blackbelt-technology/pi-dashboard-shared/platform/binary-lookup.js", () => ({
  ToolResolver: function MockToolResolver() {
    return {
      resolvePi: vi.fn().mockReturnValue(["pi"]),
      resolveNode: vi.fn().mockReturnValue("/usr/bin/node"),
    };
  },
}));

import { handleSpawnSession } from "../browser-handlers/session-action-handler.js";
import { spawnPiSession } from "../process-manager.js";
import { createBridgeRegistry } from "../pi-gateway.js";

const mockSpawnPiSession = vi.mocked(spawnPiSession);

// Captured payloads — one bag for browser-bound `sendTo` calls, one for
// the bridge `ws.send` calls. The handler treats them as different
// channels so the test keeps them split for clearer assertions.
interface CapturedMessage {
  type: string;
  [k: string]: unknown;
}

function makeBridge(readyState: number = WebSocket.OPEN): {
  ws: WSType;
  sent: CapturedMessage[];
} {
  const sent: CapturedMessage[] = [];
  const send = vi.fn((raw: string) => {
    sent.push(JSON.parse(raw) as CapturedMessage);
  });
  // Cast through `unknown` because the production code only invokes
  // `.send` and reads `.readyState`; a real WebSocket would drag in
  // event emitter plumbing that the test does not need.
  const ws = { readyState, send } as unknown as WSType;
  return { ws, sent };
}

function makeCtx(opts?: { bridgeForId?: Record<string, WSType | undefined> }) {
  const browserMessages: CapturedMessage[] = [];
  const ws = { readyState: WebSocket.OPEN } as unknown as WSType;
  const sendTo = vi.fn((_target: WSType, msg: CapturedMessage) => {
    browserMessages.push(msg);
  });
  const findBridgeByMachineId = vi.fn((id: string): WSType | undefined => {
    return opts?.bridgeForId?.[id];
  });
  const ctx = {
    ws,
    headlessPidRegistry: { register: vi.fn() },
    pendingDashboardSpawns: new Map<string, number>(),
    pendingAttachRegistry: { enqueue: vi.fn() },
    pendingWorktreeBaseRegistry: { enqueue: vi.fn() },
    pendingClientCorrelations: { record: vi.fn() },
    sessionManager: {},
    broadcast: vi.fn(),
    piGateway: { findBridgeByMachineId },
    sendTo,
  };
  // The handler is typed against the production BrowserHandlerContext.
  // We hand it the partial shape it actually consumes; the `as never`
  // hop keeps the strict checker honest about the missing surface.
  return { ctx: ctx as never, sendTo, findBridgeByMachineId, browserMessages };
}

describe("handleSpawnSession — machineId routing", () => {
  const ORIGINAL_LOCAL_ID = process.env.WALLE_MACHINE_ID;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSpawnPiSession.mockResolvedValue({
      success: true,
      pid: 4242,
      process: undefined,
      dashboardSpawned: true,
      message: "spawned",
      logPath: "/tmp/pi.log",
    } as never);
  });

  afterEach(() => {
    if (ORIGINAL_LOCAL_ID === undefined) {
      delete process.env.WALLE_MACHINE_ID;
    } else {
      process.env.WALLE_MACHINE_ID = ORIGINAL_LOCAL_ID;
    }
  });

  it("falls through to local spawn when machineId is unset", async () => {
    delete process.env.WALLE_MACHINE_ID;
    const { ctx, findBridgeByMachineId } = makeCtx();
    await handleSpawnSession(
      { type: "spawn_session", cwd: "/p/x", requestId: "req-1" } as never,
      ctx,
    );
    expect(mockSpawnPiSession).toHaveBeenCalledTimes(1);
    expect(findBridgeByMachineId).not.toHaveBeenCalled();
  });

  it("falls through to local spawn when machineId matches WALLE_MACHINE_ID", async () => {
    process.env.WALLE_MACHINE_ID = "daemon-laptop";
    const { ctx, findBridgeByMachineId } = makeCtx();
    await handleSpawnSession(
      {
        type: "spawn_session",
        cwd: "/p/x",
        requestId: "req-2",
        machineId: "daemon-laptop",
      } as never,
      ctx,
    );
    expect(mockSpawnPiSession).toHaveBeenCalledTimes(1);
    expect(findBridgeByMachineId).not.toHaveBeenCalled();
  });

  it("emits spawn_on_machine frame and synchronous spawn_result when target bridge is online", async () => {
    process.env.WALLE_MACHINE_ID = "daemon-laptop";
    const { ws: bridgeWs, sent: bridgeSent } = makeBridge();
    const { ctx, sendTo, findBridgeByMachineId, browserMessages } = makeCtx({
      bridgeForId: { "remote-mac": bridgeWs },
    });

    await handleSpawnSession(
      {
        type: "spawn_session",
        cwd: "/work/remote",
        requestId: "req-remote-1",
        machineId: "remote-mac",
        attachProposal: "add-foo",
        gitWorktreeBase: "main",
      } as never,
      ctx,
    );

    // Routing decision was taken.
    expect(findBridgeByMachineId).toHaveBeenCalledWith("remote-mac");
    // Local spawn path was skipped.
    expect(mockSpawnPiSession).not.toHaveBeenCalled();
    // Exactly one frame was sent over the bridge connection.
    expect(bridgeSent).toHaveLength(1);
    expect(bridgeSent[0]).toEqual({
      type: "spawn_on_machine",
      requestId: "req-remote-1",
      cwd: "/work/remote",
      attachProposal: "add-foo",
      gitWorktreeBase: "main",
    });
    // Synchronous spawn_result success keeps the placeholder card on
    // the originating browser until the remote session_register lands.
    const result = browserMessages.find((m) => m.type === "spawn_result");
    expect(result).toBeDefined();
    expect(result).toMatchObject({
      type: "spawn_result",
      cwd: "/work/remote",
      success: true,
      requestId: "req-remote-1",
    });
    // No spawn_error is emitted on the happy path.
    expect(browserMessages.some((m) => m.type === "spawn_error")).toBe(false);
    // And the browser sendTo was used (not the bridge ws) for the result.
    expect(sendTo).toHaveBeenCalled();
  });

  it("omits optional fields from the spawn_on_machine frame when caller did not set them", async () => {
    process.env.WALLE_MACHINE_ID = "daemon-laptop";
    const { ws: bridgeWs, sent: bridgeSent } = makeBridge();
    const { ctx } = makeCtx({ bridgeForId: { "remote-mac": bridgeWs } });

    await handleSpawnSession(
      {
        type: "spawn_session",
        cwd: "/work/remote",
        requestId: "req-remote-2",
        machineId: "remote-mac",
      } as never,
      ctx,
    );

    expect(bridgeSent).toHaveLength(1);
    expect(bridgeSent[0]).toEqual({
      type: "spawn_on_machine",
      requestId: "req-remote-2",
      cwd: "/work/remote",
    });
  });

  it("synthesizes a requestId when the client did not provide one", async () => {
    process.env.WALLE_MACHINE_ID = "daemon-laptop";
    const { ws: bridgeWs, sent: bridgeSent } = makeBridge();
    const { ctx, browserMessages } = makeCtx({
      bridgeForId: { "remote-mac": bridgeWs },
    });

    await handleSpawnSession(
      {
        type: "spawn_session",
        cwd: "/work/remote",
        machineId: "remote-mac",
      } as never,
      ctx,
    );

    expect(bridgeSent).toHaveLength(1);
    const frame = bridgeSent[0]!;
    expect(typeof frame.requestId).toBe("string");
    expect((frame.requestId as string).length).toBeGreaterThan(0);
    // spawn_result echoes the synthesized id so the client can adopt it.
    const result = browserMessages.find((m) => m.type === "spawn_result");
    expect(result?.requestId).toBe(frame.requestId);
  });

  it("emits spawn_error MACHINE_OFFLINE when no bridge is connected for the target id", async () => {
    process.env.WALLE_MACHINE_ID = "daemon-laptop";
    const { ctx, findBridgeByMachineId, browserMessages } = makeCtx({
      bridgeForId: {},
    });

    await handleSpawnSession(
      {
        type: "spawn_session",
        cwd: "/work/remote",
        requestId: "req-remote-3",
        machineId: "remote-mac",
      } as never,
      ctx,
    );

    // Routing was attempted, local spawn was not.
    expect(findBridgeByMachineId).toHaveBeenCalledWith("remote-mac");
    expect(mockSpawnPiSession).not.toHaveBeenCalled();

    // Browser gets the placeholder-dismissing spawn_result and the
    // typed spawn_error banner. The requestId echoes on both so the
    // client can correlate either one with its in-flight placeholder.
    const result = browserMessages.find((m) => m.type === "spawn_result");
    expect(result).toMatchObject({
      type: "spawn_result",
      cwd: "/work/remote",
      success: false,
      message: "Machine remote-mac is not online",
      requestId: "req-remote-3",
    });
    const error = browserMessages.find((m) => m.type === "spawn_error");
    expect(error).toMatchObject({
      type: "spawn_error",
      cwd: "/work/remote",
      strategy: "remote",
      code: "MACHINE_OFFLINE",
      message: "Machine remote-mac is not online",
      requestId: "req-remote-3",
    });
  });
});

describe("createBridgeRegistry", () => {
  // Each test mints its own fake ws inline as
  // `{ readyState: WebSocket.OPEN } as unknown as WSType`. The registry
  // only inspects `readyState`, so the rest of the WebSocket surface is
  // intentionally absent.
  it("find returns undefined for an unknown id", () => {
    const reg = createBridgeRegistry();
    expect(reg.find("nobody")).toBeUndefined();
  });

  it("find returns the most recently registered bridge for an id (LIFO)", () => {
    const reg = createBridgeRegistry();
    const older = { readyState: WebSocket.OPEN } as unknown as WSType;
    const newer = { readyState: WebSocket.OPEN } as unknown as WSType;
    reg.register("laptop", older);
    reg.register("laptop", newer);
    expect(reg.find("laptop")).toBe(newer);
  });

  it("unregister drops the ws and falls back to the prior bridge", () => {
    const reg = createBridgeRegistry();
    const older = { readyState: WebSocket.OPEN } as unknown as WSType;
    const newer = { readyState: WebSocket.OPEN } as unknown as WSType;
    reg.register("laptop", older);
    reg.register("laptop", newer);
    reg.unregister("laptop", newer);
    expect(reg.find("laptop")).toBe(older);
    reg.unregister("laptop", older);
    expect(reg.find("laptop")).toBeUndefined();
  });

  it("unregister of an unknown ws is a no-op", () => {
    const reg = createBridgeRegistry();
    const ws1 = { readyState: WebSocket.OPEN } as unknown as WSType;
    const ws2 = { readyState: WebSocket.OPEN } as unknown as WSType;
    reg.register("laptop", ws1);
    reg.unregister("laptop", ws2);
    expect(reg.find("laptop")).toBe(ws1);
  });

  it("find skips CLOSING/CLOSED entries and prefers the most recent OPEN ws", () => {
    const reg = createBridgeRegistry();
    const open = { readyState: WebSocket.OPEN } as unknown as WSType;
    const stale = { readyState: WebSocket.CLOSING } as unknown as WSType;
    reg.register("laptop", open);
    reg.register("laptop", stale);
    // Newer is non-OPEN — fall back through the stack to the OPEN one.
    expect(reg.find("laptop")).toBe(open);
  });

  it("register and unregister no-op on empty machineId", () => {
    const reg = createBridgeRegistry();
    const ws = { readyState: WebSocket.OPEN } as unknown as WSType;
    reg.register("", ws);
    expect(reg.find("")).toBeUndefined();
    // Should not throw and should not pollute any other id.
    reg.unregister("", ws);
    expect(reg.find("laptop")).toBeUndefined();
  });

  it("clear drops every entry", () => {
    const reg = createBridgeRegistry();
    reg.register("a", { readyState: WebSocket.OPEN } as unknown as WSType);
    reg.register("b", { readyState: WebSocket.OPEN } as unknown as WSType);
    reg.clear();
    expect(reg.find("a")).toBeUndefined();
    expect(reg.find("b")).toBeUndefined();
  });
});
