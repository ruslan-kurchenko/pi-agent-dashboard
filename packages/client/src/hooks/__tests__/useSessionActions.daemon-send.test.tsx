/**
 * handleSend honesty for daemon (WALL•E) sessions.
 * See change: walle-daemon-continue-honesty.
 *
 *  - daemon session WITH daemonThreadId → continue via the /inject transport
 *    (POST /api/machines/<id>/message), never a host-local send_prompt relay.
 *  - daemon session WITHOUT daemonThreadId (archived autonomous task) → a toast
 *    and NO send: there is no resumable wall-e thread, and the host-pi relay
 *    would 401.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { renderHook } from "@testing-library/react";
import { useSessionActions, type SessionActionDeps } from "../useSessionActions.js";
import type { SessionState } from "../../lib/event-reducer.js";
import type { TerminalSession } from "@blackbelt-technology/pi-dashboard-shared/terminal-types.js";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";

/** Typed no-op React state setter for deps we don't exercise. */
function noopDispatch<T>(): React.Dispatch<React.SetStateAction<T>> {
  // Mock call signature is wider than Dispatch; narrow at this seam only.
  return vi.fn() as unknown as React.Dispatch<React.SetStateAction<T>>;
}

function makeDaemonSession(overrides?: Partial<DashboardSession>): DashboardSession {
  return {
    id: "s-daemon",
    cwd: "/workspace/task",
    source: "tui",
    status: "ended",
    startedAt: Date.now() - 60_000,
    tokensIn: 0,
    tokensOut: 0,
    cost: 0,
    sessionFile: "/sessions/s-daemon.jsonl",
    machine: { id: "walle-daemon" },
    ...overrides,
  };
}

function setup(session: DashboardSession) {
  const send = vi.fn();
  const notify = vi.fn();
  const sessions = new Map<string, DashboardSession>([[session.id, session]]);
  const deps: SessionActionDeps = {
    selectedId: session.id,
    send,
    navigate: vi.fn(),
    setMobileOpen: noopDispatch<boolean>(),
    sessions,
    setSessions: noopDispatch<Map<string, DashboardSession>>(),
    setSessionStates: noopDispatch<Map<string, SessionState>>(),
    setSpawningCwds: noopDispatch<Set<string>>(),
    setTerminals: noopDispatch<Map<string, TerminalSession>>(),
    clearSpawningCwd: vi.fn(),
    spawnTimeoutsRef: { current: new Map<string, ReturnType<typeof setTimeout>>() },
    pendingTerminalCwdRef: { current: null },
    terminals: new Map(),
    pendingSpawnsRef: { current: new Map() },
    apiBase: "http://dash.local",
    machines: [],
    notify,
  };
  const { result } = renderHook(() => useSessionActions(deps));
  return { actions: result.current, send, notify };
}

describe("useSessionActions.handleSend — daemon honesty", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("archived daemon session (no daemonThreadId) → toast + no send, no inject", () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const { actions, send, notify } = setup(makeDaemonSession({ daemonThreadId: undefined }));

    actions.handleSend("hello?");

    expect(notify).toHaveBeenCalledWith(
      "Archived WALL•E session — start a New session to talk to WALL•E",
    );
    expect(send).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("daemon session WITH daemonThreadId → /inject POST, never host-local send_prompt", () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ success: true }),
    }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const { actions, send, notify } = setup(makeDaemonSession({ daemonThreadId: "thread-42" }));

    actions.handleSend("carry on");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("http://dash.local/api/machines/walle-daemon/message");
    expect(JSON.parse(String(init?.body))).toEqual({
      text: "carry on",
      threadId: "thread-42",
    });
    expect(send).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalledWith(
      "Archived WALL•E session — start a New session to talk to WALL•E",
    );
  });

  it("non-daemon session → host-local send_prompt relay (unchanged)", () => {
    const { actions, send, notify } = setup(
      makeDaemonSession({ machine: { id: "mac-laptop" }, status: "active", daemonThreadId: undefined }),
    );

    actions.handleSend("hi", undefined, "followUp");

    expect(send).toHaveBeenCalledWith({
      type: "send_prompt",
      sessionId: "s-daemon",
      text: "hi",
      images: undefined,
      delivery: "followUp",
    });
    expect(notify).not.toHaveBeenCalled();
  });
});
