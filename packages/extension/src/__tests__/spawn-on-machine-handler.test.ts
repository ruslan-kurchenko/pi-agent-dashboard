/**
 * walle-multi-machine: unit tests for the bridge-side `spawn_on_machine`
 * handler. Drives the module through every transition in its contract:
 *   - invoke on incoming frame
 *   - tag the matching `session_register`
 *   - pass-through on non-matching `session_register`
 *   - timeout expires entries and emits `spawn_on_machine_failed`
 *   - multiple concurrent pending spawns tracked independently
 *   - same cwd twice → second overwrites, first is timed out
 *   - invokeLocalAgent throwing → AGENT_INVOKE_FAILED, entry dropped
 *
 * See change: walle-multi-machine.
 */
import { describe, it, expect, vi } from "vitest";
import {
  createSpawnOnMachineHandler,
  SPAWN_REGISTER_TIMEOUT_MS,
  type SpawnOnMachineContext,
} from "../spawn-on-machine-handler.js";
import type {
  SessionRegisterMessage,
  SpawnOnMachineExtensionMessage,
} from "@blackbelt-technology/pi-dashboard-shared/protocol.js";

function makeRegister(cwd: string): SessionRegisterMessage {
  return {
    type: "session_register",
    sessionId: "sess-" + cwd,
    cwd,
    source: "dashboard",
  };
}

function makeSpawnFrame(
  cwd: string,
  requestId: string,
  extra: Partial<SpawnOnMachineExtensionMessage> = {},
): SpawnOnMachineExtensionMessage {
  return { type: "spawn_on_machine", cwd, requestId, ...extra };
}

interface Harness {
  ctx: SpawnOnMachineContext;
  sent: unknown[];
  invocations: Array<{ cwd: string; opts: { attachProposal?: string; gitWorktreeBase?: string } }>;
  invokeImpl: { value: (cwd: string, opts: { attachProposal?: string; gitWorktreeBase?: string }) => Promise<void> };
  clock: { value: number };
  warnings: string[];
  errors: string[];
}

function makeHarness(): Harness {
  const sent: unknown[] = [];
  const invocations: Harness["invocations"] = [];
  const clock = { value: 1_000_000 };
  const warnings: string[] = [];
  const errors: string[] = [];
  const invokeImpl: Harness["invokeImpl"] = {
    value: async () => {
      /* default no-op success */
    },
  };
  const ctx: SpawnOnMachineContext = {
    sendUpstream: (msg) => sent.push(msg),
    invokeLocalAgent: async (cwd, opts) => {
      invocations.push({ cwd, opts });
      await invokeImpl.value(cwd, opts);
    },
    now: () => clock.value,
    logger: {
      warn: (m) => warnings.push(m),
      error: (m) => errors.push(m),
    },
  };
  return { ctx, sent, invocations, invokeImpl, clock, warnings, errors };
}

describe("spawn-on-machine-handler / handle()", () => {
  it("invokes invokeLocalAgent and tracks the entry in the pending map", async () => {
    const h = makeHarness();
    const handler = createSpawnOnMachineHandler(h.ctx);

    await handler.handle(
      makeSpawnFrame("/work/repo", "req-1", { attachProposal: "feature-x", gitWorktreeBase: "main" }),
    );

    expect(h.invocations).toEqual([
      { cwd: "/work/repo", opts: { attachProposal: "feature-x", gitWorktreeBase: "main" } },
    ]);
    expect(h.sent).toEqual([]);
    const pending = handler._peekPending();
    expect(pending.size).toBe(1);
    const entry = pending.get("/work/repo")!;
    expect(entry).toMatchObject({
      requestId: "req-1",
      cwd: "/work/repo",
      attachProposal: "feature-x",
      gitWorktreeBase: "main",
      expiresAt: 1_000_000 + SPAWN_REGISTER_TIMEOUT_MS,
    });
  });

  it("emits AGENT_INVOKE_FAILED and drops the entry when invokeLocalAgent throws", async () => {
    const h = makeHarness();
    h.invokeImpl.value = async () => {
      throw new Error("ENOENT: omp not found");
    };
    const handler = createSpawnOnMachineHandler(h.ctx);

    await handler.handle(makeSpawnFrame("/work/repo", "req-1"));

    expect(handler._peekPending().size).toBe(0);
    expect(h.sent).toEqual([
      {
        type: "spawn_on_machine_failed",
        requestId: "req-1",
        cwd: "/work/repo",
        code: "AGENT_INVOKE_FAILED",
        message: "ENOENT: omp not found",
      },
    ]);
    expect(h.errors.length).toBe(1);
  });
});

describe("spawn-on-machine-handler / onSessionRegister()", () => {
  it("tags a matching cwd register with spawnRequestId and clears the entry", async () => {
    const h = makeHarness();
    const handler = createSpawnOnMachineHandler(h.ctx);
    await handler.handle(makeSpawnFrame("/work/repo", "req-42"));

    const out = handler.onSessionRegister(makeRegister("/work/repo"));

    expect(out.spawnRequestId).toBe("req-42");
    expect(out.cwd).toBe("/work/repo");
    expect(out.sessionId).toBe("sess-/work/repo");
    expect(handler._peekPending().size).toBe(0);
  });

  it("returns the message UNCHANGED when no entry matches the cwd", () => {
    const h = makeHarness();
    const handler = createSpawnOnMachineHandler(h.ctx);
    const incoming = makeRegister("/other/place");

    const out = handler.onSessionRegister(incoming);

    expect(out).toBe(incoming); // same reference, no spread
    expect((out as { spawnRequestId?: string }).spawnRequestId).toBeUndefined();
  });

  it("only tags the FIRST register for a given cwd; subsequent ones pass through", async () => {
    const h = makeHarness();
    const handler = createSpawnOnMachineHandler(h.ctx);
    await handler.handle(makeSpawnFrame("/work/repo", "req-1"));

    const tagged = handler.onSessionRegister(makeRegister("/work/repo"));
    const second = handler.onSessionRegister(makeRegister("/work/repo"));

    expect(tagged.spawnRequestId).toBe("req-1");
    expect((second as { spawnRequestId?: string }).spawnRequestId).toBeUndefined();
  });
});

describe("spawn-on-machine-handler / tickTimeouts()", () => {
  it("does nothing when no entries have expired", async () => {
    const h = makeHarness();
    const handler = createSpawnOnMachineHandler(h.ctx);
    await handler.handle(makeSpawnFrame("/work/repo", "req-1"));

    h.clock.value += SPAWN_REGISTER_TIMEOUT_MS - 1;
    handler.tickTimeouts();

    expect(h.sent).toEqual([]);
    expect(handler._peekPending().size).toBe(1);
  });

  it("expires entries past the timeout and emits spawn_on_machine_failed with AGENT_DIDNT_REGISTER", async () => {
    const h = makeHarness();
    const handler = createSpawnOnMachineHandler(h.ctx);
    await handler.handle(makeSpawnFrame("/work/repo", "req-1"));

    h.clock.value += SPAWN_REGISTER_TIMEOUT_MS + 1;
    handler.tickTimeouts();

    expect(handler._peekPending().size).toBe(0);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({
      type: "spawn_on_machine_failed",
      requestId: "req-1",
      cwd: "/work/repo",
      code: "AGENT_DIDNT_REGISTER",
    });
  });

  it("does NOT re-emit timeouts for entries that already fired", async () => {
    const h = makeHarness();
    const handler = createSpawnOnMachineHandler(h.ctx);
    await handler.handle(makeSpawnFrame("/work/repo", "req-1"));

    h.clock.value += SPAWN_REGISTER_TIMEOUT_MS + 1;
    handler.tickTimeouts();
    handler.tickTimeouts(); // second tick — should be a no-op

    expect(h.sent).toHaveLength(1);
  });
});

describe("spawn-on-machine-handler / multiple concurrent spawns", () => {
  it("tracks distinct cwds independently and tags each register correctly", async () => {
    const h = makeHarness();
    const handler = createSpawnOnMachineHandler(h.ctx);

    await handler.handle(makeSpawnFrame("/work/a", "req-A"));
    await handler.handle(makeSpawnFrame("/work/b", "req-B"));
    await handler.handle(makeSpawnFrame("/work/c", "req-C"));

    expect(handler._peekPending().size).toBe(3);

    // Out-of-order registers must each be tagged with their own requestId.
    expect(handler.onSessionRegister(makeRegister("/work/b")).spawnRequestId).toBe("req-B");
    expect(handler.onSessionRegister(makeRegister("/work/a")).spawnRequestId).toBe("req-A");
    expect(handler.onSessionRegister(makeRegister("/work/c")).spawnRequestId).toBe("req-C");
    expect(handler._peekPending().size).toBe(0);
  });

  it("expires only the entries whose deadlines have passed", async () => {
    const h = makeHarness();
    const handler = createSpawnOnMachineHandler(h.ctx);
    await handler.handle(makeSpawnFrame("/work/a", "req-A"));
    h.clock.value += 5_000;
    await handler.handle(makeSpawnFrame("/work/b", "req-B"));

    // Advance enough to expire A but not B.
    h.clock.value = 1_000_000 + SPAWN_REGISTER_TIMEOUT_MS + 1;
    handler.tickTimeouts();

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ requestId: "req-A", code: "AGENT_DIDNT_REGISTER" });
    expect(handler._peekPending().size).toBe(1);
    expect(handler._peekPending().get("/work/b")!.requestId).toBe("req-B");
  });
});

describe("spawn-on-machine-handler / same cwd twice", () => {
  it("overwrites first with second and emits AGENT_DIDNT_REGISTER for the superseded request", async () => {
    const h = makeHarness();
    const handler = createSpawnOnMachineHandler(h.ctx);
    await handler.handle(makeSpawnFrame("/work/repo", "req-1"));
    await handler.handle(makeSpawnFrame("/work/repo", "req-2"));

    // The first request is reported as timed-out immediately on collision.
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({
      type: "spawn_on_machine_failed",
      requestId: "req-1",
      cwd: "/work/repo",
      code: "AGENT_DIDNT_REGISTER",
    });
    expect(h.warnings.length).toBe(1);

    // Only the second mapping survives; the next register tags req-2.
    expect(handler._peekPending().size).toBe(1);
    expect(handler.onSessionRegister(makeRegister("/work/repo")).spawnRequestId).toBe("req-2");
  });
});

describe("spawn-on-machine-handler / non-mutating return semantics", () => {
  it("does not mutate the original session_register message when tagging", async () => {
    const h = makeHarness();
    const handler = createSpawnOnMachineHandler(h.ctx);
    await handler.handle(makeSpawnFrame("/work/repo", "req-1"));

    const incoming = makeRegister("/work/repo");
    const before = { ...incoming };
    handler.onSessionRegister(incoming);

    expect(incoming).toEqual(before); // input untouched
    expect((incoming as { spawnRequestId?: string }).spawnRequestId).toBeUndefined();
  });
});

describe("spawn-on-machine-handler / default logger", () => {
  it("uses console.warn / console.error when no logger is injected", async () => {
    let throwNext = true;
    const ctx: SpawnOnMachineContext = {
      sendUpstream: () => {},
      invokeLocalAgent: async () => {
        if (throwNext) throw new Error("boom");
      },
      now: () => 0,
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const handler = createSpawnOnMachineHandler(ctx);
      // First spawn fails inside invokeLocalAgent → default logger.error.
      await handler.handle(makeSpawnFrame("/work/x", "req-X"));
      expect(errorSpy).toHaveBeenCalledTimes(1);
      // Now exercise the collision branch: spawn cwd=/work/y succeeds, a
      // second spawn at the same cwd supersedes it → default logger.warn.
      throwNext = false;
      await handler.handle(makeSpawnFrame("/work/y", "req-Y1"));
      await handler.handle(makeSpawnFrame("/work/y", "req-Y2"));
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
