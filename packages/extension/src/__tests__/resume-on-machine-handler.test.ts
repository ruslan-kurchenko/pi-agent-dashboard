/**
 * walle-multi-machine: unit tests for the bridge-side `resume_on_machine`
 * handler. Mirror of `spawn-on-machine-handler.test.ts` for the resume verb —
 * pending is keyed by sessionId, the matching register CLEARS the entry
 * (the server correlates by sessionId, so no requestId is tagged), and
 * failures surface as `resume_on_machine_failed`.
 *
 * Every side effect (resume shell-out, upstream send, clock) is injected,
 * so the suite is deterministic without mocking timers, files, or sockets.
 *
 * See change: walle-multi-machine.
 */
import { describe, it, expect, vi } from "vitest";
import {
  createResumeOnMachineHandler,
  type ResumeOnMachineContext,
} from "../resume-on-machine-handler.js";
import { SPAWN_REGISTER_TIMEOUT_MS } from "../spawn-on-machine-handler.js";
import type {
  SessionRegisterMessage,
  ResumeOnMachineExtensionMessage,
} from "@blackbelt-technology/pi-dashboard-shared/protocol.js";

function makeRegister(sessionId: string, cwd = "/work/repo"): SessionRegisterMessage {
  return {
    type: "session_register",
    sessionId,
    cwd,
    source: "dashboard",
  };
}

function makeResumeFrame(
  sessionId: string,
  requestId: string,
  extra: Partial<ResumeOnMachineExtensionMessage> = {},
): ResumeOnMachineExtensionMessage {
  return {
    type: "resume_on_machine",
    sessionId,
    requestId,
    cwd: "/work/repo",
    mode: "continue",
    ...extra,
  };
}

interface Harness {
  ctx: ResumeOnMachineContext;
  sent: unknown[];
  invocations: Array<{ sessionId: string; cwd: string; mode: "continue" | "fork" }>;
  resumeImpl: { value: (sessionId: string, cwd: string, mode: "continue" | "fork") => Promise<void> };
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
  const resumeImpl: Harness["resumeImpl"] = {
    value: async () => {
      /* default no-op success */
    },
  };
  const ctx: ResumeOnMachineContext = {
    sendUpstream: (msg) => sent.push(msg),
    resumeLocalAgent: async (sessionId, cwd, mode) => {
      invocations.push({ sessionId, cwd, mode });
      await resumeImpl.value(sessionId, cwd, mode);
    },
    now: () => clock.value,
    logger: {
      warn: (m) => warnings.push(m),
      error: (m) => errors.push(m),
    },
  };
  return { ctx, sent, invocations, resumeImpl, clock, warnings, errors };
}

describe("resume-on-machine-handler / handle()", () => {
  it("invokes resumeLocalAgent and tracks the entry in the pending map", async () => {
    const h = makeHarness();
    const handler = createResumeOnMachineHandler(h.ctx);

    await handler.handle(makeResumeFrame("sess-1", "req-1", { cwd: "/work/x", mode: "fork" }));

    expect(h.invocations).toEqual([{ sessionId: "sess-1", cwd: "/work/x", mode: "fork" }]);
    expect(h.sent).toEqual([]);
    const pending = handler._peekPending();
    expect(pending.size).toBe(1);
    expect(pending.get("sess-1")).toMatchObject({
      requestId: "req-1",
      sessionId: "sess-1",
      cwd: "/work/x",
      mode: "fork",
      expiresAt: 1_000_000 + SPAWN_REGISTER_TIMEOUT_MS,
    });
  });

  it("emits AGENT_INVOKE_FAILED and drops the entry when resumeLocalAgent throws", async () => {
    const h = makeHarness();
    h.resumeImpl.value = async () => {
      throw new Error("ENOENT: omp not found");
    };
    const handler = createResumeOnMachineHandler(h.ctx);

    await handler.handle(makeResumeFrame("sess-1", "req-1"));

    expect(handler._peekPending().size).toBe(0);
    expect(h.sent).toEqual([
      {
        type: "resume_on_machine_failed",
        requestId: "req-1",
        sessionId: "sess-1",
        code: "AGENT_INVOKE_FAILED",
        detail: "ENOENT: omp not found",
      },
    ]);
    expect(h.errors.length).toBe(1);
  });
});

describe("resume-on-machine-handler / onSessionRegister()", () => {
  it("clears a matching sessionId entry and returns the message UNCHANGED (no requestId tag)", async () => {
    const h = makeHarness();
    const handler = createResumeOnMachineHandler(h.ctx);
    await handler.handle(makeResumeFrame("sess-42", "req-42"));

    const incoming = makeRegister("sess-42");
    const out = handler.onSessionRegister(incoming);

    expect(out).toBe(incoming); // same reference — server correlates by sessionId
    expect((out as { spawnRequestId?: string }).spawnRequestId).toBeUndefined();
    expect(handler._peekPending().size).toBe(0);
  });

  it("returns the message UNCHANGED when no entry matches the sessionId", () => {
    const h = makeHarness();
    const handler = createResumeOnMachineHandler(h.ctx);
    const incoming = makeRegister("sess-other");

    const out = handler.onSessionRegister(incoming);

    expect(out).toBe(incoming);
    expect(handler._peekPending().size).toBe(0);
  });
});

describe("resume-on-machine-handler / tickTimeouts()", () => {
  it("does nothing when no entries have expired", async () => {
    const h = makeHarness();
    const handler = createResumeOnMachineHandler(h.ctx);
    await handler.handle(makeResumeFrame("sess-1", "req-1"));

    h.clock.value += SPAWN_REGISTER_TIMEOUT_MS - 1;
    handler.tickTimeouts();

    expect(h.sent).toEqual([]);
    expect(handler._peekPending().size).toBe(1);
  });

  it("expires entries past the timeout and emits resume_on_machine_failed with AGENT_DIDNT_REGISTER", async () => {
    const h = makeHarness();
    const handler = createResumeOnMachineHandler(h.ctx);
    await handler.handle(makeResumeFrame("sess-1", "req-1"));

    h.clock.value += SPAWN_REGISTER_TIMEOUT_MS + 1;
    handler.tickTimeouts();

    expect(handler._peekPending().size).toBe(0);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({
      type: "resume_on_machine_failed",
      requestId: "req-1",
      sessionId: "sess-1",
      code: "AGENT_DIDNT_REGISTER",
    });
  });

  it("does NOT re-emit timeouts for entries that already fired", async () => {
    const h = makeHarness();
    const handler = createResumeOnMachineHandler(h.ctx);
    await handler.handle(makeResumeFrame("sess-1", "req-1"));

    h.clock.value += SPAWN_REGISTER_TIMEOUT_MS + 1;
    handler.tickTimeouts();
    handler.tickTimeouts(); // second tick — no-op

    expect(h.sent).toHaveLength(1);
  });

  it("a successful register before the deadline prevents the timeout from firing", async () => {
    const h = makeHarness();
    const handler = createResumeOnMachineHandler(h.ctx);
    await handler.handle(makeResumeFrame("sess-1", "req-1"));

    handler.onSessionRegister(makeRegister("sess-1")); // resumed agent re-registers
    h.clock.value += SPAWN_REGISTER_TIMEOUT_MS + 1;
    handler.tickTimeouts();

    expect(h.sent).toEqual([]);
    expect(handler._peekPending().size).toBe(0);
  });
});

describe("resume-on-machine-handler / multiple concurrent resumes", () => {
  it("tracks distinct sessionIds independently and clears each register correctly", async () => {
    const h = makeHarness();
    const handler = createResumeOnMachineHandler(h.ctx);

    await handler.handle(makeResumeFrame("sess-a", "req-A"));
    await handler.handle(makeResumeFrame("sess-b", "req-B"));
    await handler.handle(makeResumeFrame("sess-c", "req-C"));

    expect(handler._peekPending().size).toBe(3);

    handler.onSessionRegister(makeRegister("sess-b"));
    handler.onSessionRegister(makeRegister("sess-a"));
    expect(handler._peekPending().size).toBe(1);

    // Only sess-c remains; advancing the clock expires exactly that one.
    h.clock.value += SPAWN_REGISTER_TIMEOUT_MS + 1;
    handler.tickTimeouts();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ requestId: "req-C", sessionId: "sess-c", code: "AGENT_DIDNT_REGISTER" });
  });
});

describe("resume-on-machine-handler / same sessionId twice", () => {
  it("supersedes the first with the second and reports AGENT_DIDNT_REGISTER for the old request", async () => {
    const h = makeHarness();
    const handler = createResumeOnMachineHandler(h.ctx);
    await handler.handle(makeResumeFrame("sess-1", "req-1"));
    await handler.handle(makeResumeFrame("sess-1", "req-2"));

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({
      type: "resume_on_machine_failed",
      requestId: "req-1",
      sessionId: "sess-1",
      code: "AGENT_DIDNT_REGISTER",
    });
    expect(h.warnings.length).toBe(1);

    expect(handler._peekPending().size).toBe(1);
    expect(handler._peekPending().get("sess-1")!.requestId).toBe("req-2");
  });
});

describe("resume-on-machine-handler / default logger", () => {
  it("uses console.warn / console.error when no logger is injected", async () => {
    let throwNext = true;
    const ctx: ResumeOnMachineContext = {
      sendUpstream: () => {},
      resumeLocalAgent: async () => {
        if (throwNext) throw new Error("boom");
      },
      now: () => 0,
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const handler = createResumeOnMachineHandler(ctx);
      await handler.handle(makeResumeFrame("sess-x", "req-X")); // throws → logger.error
      expect(errorSpy).toHaveBeenCalledTimes(1);
      throwNext = false;
      await handler.handle(makeResumeFrame("sess-y", "req-Y1"));
      await handler.handle(makeResumeFrame("sess-y", "req-Y2")); // supersede → logger.warn
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
