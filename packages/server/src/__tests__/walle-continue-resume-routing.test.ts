/**
 * walle-multi-machine: machine-aware Continue (handleSendPrompt) and Resume
 * (handleResumeSession) routing.
 *
 * Continue:
 *   - daemon session (local machine + daemonThreadId) → daemon `/inject`
 *     transport, NEVER host-local spawnPiSession.
 *   - laptop/remote ALIVE → existing send_prompt bridge relay.
 *   - laptop/remote ENDED → no-op (resume is the re-open path), never host pi.
 *   - local non-daemon ENDED → existing host-local auto-resume spawnPiSession.
 *
 * Resume:
 *   - remote session + online bridge → `resume_on_machine` frame + optimistic
 *     resume_result; never spawnPiSession.
 *   - remote session + no bridge → resume_result error, never spawnPiSession.
 *   - local session → existing host-local spawnPiSession resume path.
 *
 * Everything the handlers touch is mocked so no real pi binary, filesystem, or
 * network is exercised.
 * See change: walle-multi-machine.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WebSocket } from "ws";
import type { WebSocket as WSType } from "ws";

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
vi.mock("../daemon-inject.js", () => ({
  injectToDaemon: vi.fn(),
}));
vi.mock("@blackbelt-technology/pi-dashboard-shared/config.js", () => ({
  loadConfig: vi.fn().mockReturnValue({
    spawnStrategy: "headless" as const,
    spawnRegisterTimeoutMs: 30000,
  }),
}));

import {
  handleSendPrompt,
  handleResumeSession,
} from "../browser-handlers/session-action-handler.js";
import { spawnPiSession } from "../process-manager.js";
import { injectToDaemon } from "../daemon-inject.js";

const mockSpawnPiSession = vi.mocked(spawnPiSession);
const mockInjectToDaemon = vi.mocked(injectToDaemon);

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
  const ws = { readyState, send } as unknown as WSType;
  return { ws, sent };
}

type SessionShape = {
  id: string;
  cwd: string;
  status: string;
  sessionFile?: string;
  machine?: { id: string };
  daemonThreadId?: string;
  resuming?: boolean;
};

function makeCtx(opts?: {
  session?: SessionShape;
  bridgeForId?: Record<string, WSType | undefined>;
}) {
  const browserMessages: CapturedMessage[] = [];
  const ws = { readyState: WebSocket.OPEN } as unknown as WSType;
  const sendTo = vi.fn((_target: WSType, msg: CapturedMessage) => {
    browserMessages.push(msg);
  });
  const findBridgeByMachineId = vi.fn((id: string): WSType | undefined => {
    return opts?.bridgeForId?.[id];
  });
  const sendToSession = vi.fn().mockReturnValue(true);
  const update = vi.fn();
  const ctx = {
    ws,
    sessionManager: {
      get: vi.fn(() => opts?.session),
      update,
    },
    piGateway: { findBridgeByMachineId, sendToSession },
    headlessPidRegistry: { register: vi.fn(), getPid: vi.fn(() => undefined) },
    pendingResumeRegistry: { record: vi.fn(), consume: vi.fn() },
    pendingResumeIntents: { record: vi.fn() },
    pendingDashboardSpawns: new Map<string, number>(),
    pendingForkRegistry: { recordFork: vi.fn() },
    pendingClientCorrelations: { record: vi.fn() },
    broadcast: vi.fn(),
    sendTo,
  };
  return {
    ctx: ctx as never,
    sendTo,
    sendToSession,
    findBridgeByMachineId,
    update,
    browserMessages,
  };
}

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
  mockInjectToDaemon.mockResolvedValue({ ok: true, threadId: "t-1" });
  process.env.WALLE_MACHINE_ID = "walle-daemon";
});

afterEach(() => {
  if (ORIGINAL_LOCAL_ID === undefined) delete process.env.WALLE_MACHINE_ID;
  else process.env.WALLE_MACHINE_ID = ORIGINAL_LOCAL_ID;
});

describe("handleSendPrompt — machine-aware Continue routing", () => {
  it("routes a daemon session (daemonThreadId) to the inject transport, never host pi", async () => {
    const { ctx, sendToSession } = makeCtx({
      session: {
        id: "s-daemon",
        cwd: "/work/x",
        status: "ended",
        sessionFile: "/sessions/s-daemon.jsonl",
        machine: { id: "walle-daemon" },
        daemonThreadId: "thread-99",
      },
    });
    await handleSendPrompt(
      { type: "send_prompt", sessionId: "s-daemon", text: "carry on" } as never,
      ctx,
    );
    expect(mockInjectToDaemon).toHaveBeenCalledTimes(1);
    expect(mockInjectToDaemon).toHaveBeenCalledWith("carry on", "thread-99");
    // Daemon continue never spawns a host pi and never relays via the bridge.
    expect(mockSpawnPiSession).not.toHaveBeenCalled();
    expect(sendToSession).not.toHaveBeenCalled();
  });

  it("routes a daemon session even when alive (machine undefined → host machine) via inject", async () => {
    const { ctx, sendToSession } = makeCtx({
      session: {
        id: "s-daemon2",
        cwd: "/work/x",
        status: "active",
        // No explicit machine → host machine (local). daemonThreadId still set.
        daemonThreadId: "thread-7",
      },
    });
    await handleSendPrompt(
      { type: "send_prompt", sessionId: "s-daemon2", text: "go" } as never,
      ctx,
    );
    expect(mockInjectToDaemon).toHaveBeenCalledWith("go", "thread-7");
    expect(mockSpawnPiSession).not.toHaveBeenCalled();
    expect(sendToSession).not.toHaveBeenCalled();
  });

  it("relays an ALIVE laptop/remote session via the existing send_prompt bridge path", async () => {
    const { ctx, sendToSession } = makeCtx({
      session: {
        id: "s-remote",
        cwd: "/work/r",
        status: "active",
        machine: { id: "mac-laptop" },
      },
    });
    await handleSendPrompt(
      { type: "send_prompt", sessionId: "s-remote", text: "hello" } as never,
      ctx,
    );
    expect(sendToSession).toHaveBeenCalledTimes(1);
    expect(sendToSession).toHaveBeenCalledWith("s-remote", expect.objectContaining({
      type: "send_prompt",
      sessionId: "s-remote",
      text: "hello",
    }));
    expect(mockInjectToDaemon).not.toHaveBeenCalled();
    expect(mockSpawnPiSession).not.toHaveBeenCalled();
  });

  it("does NOT spawn host pi for an ENDED laptop/remote session (resume is the re-open path)", async () => {
    const { ctx, sendToSession } = makeCtx({
      session: {
        id: "s-remote-ended",
        cwd: "/work/r",
        status: "ended",
        sessionFile: "/sessions/s-remote-ended.jsonl",
        machine: { id: "mac-laptop" },
      },
    });
    await handleSendPrompt(
      { type: "send_prompt", sessionId: "s-remote-ended", text: "ping" } as never,
      ctx,
    );
    expect(mockSpawnPiSession).not.toHaveBeenCalled();
    expect(mockInjectToDaemon).not.toHaveBeenCalled();
    expect(sendToSession).not.toHaveBeenCalled();
  });

  it("preserves the host-local auto-resume for a machine-less local ENDED session", async () => {
    const { ctx } = makeCtx({
      session: {
        id: "s-local",
        cwd: "/work/local",
        status: "ended",
        sessionFile: "/sessions/s-local.jsonl",
        // No machine field → genuinely local (upstream single-machine install /
        // pre-migration). NOT a daemon session, so the host-local auto-resume
        // (spawnPiSession) is preserved.
      },
    });
    await handleSendPrompt(
      { type: "send_prompt", sessionId: "s-local", text: "resume me" } as never,
      ctx,
    );
    // Upstream single-machine behaviour: host-local spawnPiSession auto-resume.
    expect(mockSpawnPiSession).toHaveBeenCalledTimes(1);
    expect(mockInjectToDaemon).not.toHaveBeenCalled();
  });

  it("does NOT spawn host pi for an ARCHIVED daemon session (machine === local, no daemonThreadId)", async () => {
    const { ctx, sendToSession } = makeCtx({
      session: {
        id: "s-archived-daemon",
        cwd: "/workspace/task",
        status: "ended",
        sessionFile: "/sessions/s-archived-daemon.jsonl",
        // machine.id === local daemon id AND no daemonThreadId → archived
        // autonomous task. No resumable wall-e thread; a host-pi spawn would
        // 401. See change: walle-daemon-continue-honesty.
        machine: { id: "walle-daemon" },
      },
    });
    await handleSendPrompt(
      { type: "send_prompt", sessionId: "s-archived-daemon", text: "you there?" } as never,
      ctx,
    );
    expect(mockSpawnPiSession).not.toHaveBeenCalled();
    expect(mockInjectToDaemon).not.toHaveBeenCalled();
    expect(sendToSession).not.toHaveBeenCalled();
  });
});

describe("handleResumeSession — machine-aware Resume routing", () => {
  it("emits a resume_on_machine frame + optimistic resume_result when the bridge is online", async () => {
    const { ws: bridgeWs, sent: bridgeSent } = makeBridge();
    const { ctx, browserMessages, findBridgeByMachineId } = makeCtx({
      session: {
        id: "s-remote",
        cwd: "/work/remote",
        status: "ended",
        sessionFile: "/sessions/s-remote.jsonl",
        machine: { id: "mac-laptop" },
      },
      bridgeForId: { "mac-laptop": bridgeWs },
    });
    await handleResumeSession(
      {
        type: "resume_session",
        sessionId: "s-remote",
        mode: "continue",
        requestId: "req-r1",
      } as never,
      ctx,
    );
    expect(findBridgeByMachineId).toHaveBeenCalledWith("mac-laptop");
    expect(mockSpawnPiSession).not.toHaveBeenCalled();
    expect(bridgeSent).toHaveLength(1);
    expect(bridgeSent[0]).toEqual({
      type: "resume_on_machine",
      requestId: "req-r1",
      sessionId: "s-remote",
      cwd: "/work/remote",
      mode: "continue",
    });
    const result = browserMessages.find((m) => m.type === "resume_result");
    expect(result).toMatchObject({
      type: "resume_result",
      sessionId: "s-remote",
      success: true,
      requestId: "req-r1",
    });
  });

  it("forwards mode:'fork' through the resume_on_machine frame", async () => {
    const { ws: bridgeWs, sent: bridgeSent } = makeBridge();
    const { ctx } = makeCtx({
      session: {
        id: "s-remote",
        cwd: "/work/remote",
        status: "ended",
        sessionFile: "/sessions/s-remote.jsonl",
        machine: { id: "mac-laptop" },
      },
      bridgeForId: { "mac-laptop": bridgeWs },
    });
    await handleResumeSession(
      {
        type: "resume_session",
        sessionId: "s-remote",
        mode: "fork",
        requestId: "req-r2",
      } as never,
      ctx,
    );
    expect(bridgeSent[0]).toMatchObject({ type: "resume_on_machine", mode: "fork" });
  });

  it("emits a resume_result error and never spawns when no bridge is online", async () => {
    const { ctx, browserMessages, findBridgeByMachineId } = makeCtx({
      session: {
        id: "s-remote",
        cwd: "/work/remote",
        status: "ended",
        sessionFile: "/sessions/s-remote.jsonl",
        machine: { id: "mac-laptop" },
      },
      bridgeForId: {},
    });
    await handleResumeSession(
      {
        type: "resume_session",
        sessionId: "s-remote",
        mode: "continue",
        requestId: "req-r3",
      } as never,
      ctx,
    );
    expect(findBridgeByMachineId).toHaveBeenCalledWith("mac-laptop");
    expect(mockSpawnPiSession).not.toHaveBeenCalled();
    const result = browserMessages.find((m) => m.type === "resume_result");
    expect(result).toMatchObject({
      type: "resume_result",
      sessionId: "s-remote",
      success: false,
      message: "Machine mac-laptop is not online",
      requestId: "req-r3",
    });
  });

  it("synthesizes a requestId when the client omitted one", async () => {
    const { ws: bridgeWs, sent: bridgeSent } = makeBridge();
    const { ctx, browserMessages } = makeCtx({
      session: {
        id: "s-remote",
        cwd: "/work/remote",
        status: "ended",
        sessionFile: "/sessions/s-remote.jsonl",
        machine: { id: "mac-laptop" },
      },
      bridgeForId: { "mac-laptop": bridgeWs },
    });
    await handleResumeSession(
      { type: "resume_session", sessionId: "s-remote", mode: "continue" } as never,
      ctx,
    );
    const frame = bridgeSent[0]!;
    expect(typeof frame.requestId).toBe("string");
    expect((frame.requestId as string).length).toBeGreaterThan(0);
    const result = browserMessages.find((m) => m.type === "resume_result");
    expect(result?.requestId).toBe(frame.requestId);
  });

  it("falls through to the host-local spawnPiSession path for a machine-less local session", async () => {
    const { ctx, findBridgeByMachineId } = makeCtx({
      session: {
        id: "s-local",
        cwd: "/work/local",
        status: "ended",
        sessionFile: "/sessions/s-local.jsonl",
        // No machine → genuinely local non-daemon (upstream / pre-migration).
      },
    });
    await handleResumeSession(
      {
        type: "resume_session",
        sessionId: "s-local",
        mode: "continue",
        requestId: "req-local",
      } as never,
      ctx,
    );
    expect(findBridgeByMachineId).not.toHaveBeenCalled();
    expect(mockSpawnPiSession).toHaveBeenCalledTimes(1);
  });

  it("blocks a LOCAL daemon session with a resume_result error, never spawning", async () => {
    const { ctx, browserMessages, findBridgeByMachineId } = makeCtx({
      session: {
        id: "s-daemon-ended",
        cwd: "/workspace/task",
        status: "ended",
        sessionFile: "/sessions/s-daemon-ended.jsonl",
        machine: { id: "walle-daemon" }, // === local machine id → daemon session
      },
    });
    await handleResumeSession(
      {
        type: "resume_session",
        sessionId: "s-daemon-ended",
        mode: "continue",
        requestId: "req-daemon",
      } as never,
      ctx,
    );
    expect(mockSpawnPiSession).not.toHaveBeenCalled();
    expect(findBridgeByMachineId).not.toHaveBeenCalled();
    const result = browserMessages.find((m) => m.type === "resume_result");
    expect(result).toMatchObject({
      type: "resume_result",
      sessionId: "s-daemon-ended",
      success: false,
      message: "Daemon sessions continue via the dashboard composer or New Session",
      requestId: "req-daemon",
    });
  });
});
