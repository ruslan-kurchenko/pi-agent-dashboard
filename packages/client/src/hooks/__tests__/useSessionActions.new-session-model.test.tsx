/**
 * walle-dash-fixes #6: the New Session popover's optional model + thinking-level
 * overrides must reach the wire — into the `spawn_session` message for
 * laptop/remote targets, and into the `/inject` POST body for the daemon
 * target. When the operator leaves both at "Default" the payloads must stay
 * byte-identical to the pre-#6 shape (the Continue path is unaffected).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React from "react";
import { renderHook } from "@testing-library/react";
import { useSessionActions, type SessionActionDeps } from "../useSessionActions.js";
import type { SessionState } from "../../lib/event-reducer.js";
import type { TerminalSession } from "@blackbelt-technology/pi-dashboard-shared/terminal-types.js";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import type { MachineRosterEntry } from "../useMachineRoster.js";

/** Typed no-op React state setter for deps we don't exercise. */
function noopDispatch<T>(): React.Dispatch<React.SetStateAction<T>> {
  return vi.fn() as unknown as React.Dispatch<React.SetStateAction<T>>;
}

function makeMachine(over: Partial<MachineRosterEntry> = {}): MachineRosterEntry {
  return {
    id: "mac-laptop",
    label: "Laptop",
    accent: "#5fb4a4",
    addedAt: "2026-06-17T00:00:00Z",
    status: "online",
    sessionCount: 0,
    ...over,
  };
}

function setup(machines: MachineRosterEntry[]) {
  const send = vi.fn();
  const notify = vi.fn();
  const deps: SessionActionDeps = {
    selectedId: undefined,
    send,
    navigate: vi.fn(),
    setMobileOpen: noopDispatch<boolean>(),
    sessions: new Map<string, DashboardSession>(),
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
    machines,
    notify,
  };
  const { result } = renderHook(() => useSessionActions(deps));
  return { actions: result.current, send, notify };
}

describe("useSessionActions.handleStartNewSession — model/thinking overrides (#6)", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });
  beforeEach(() => vi.clearAllMocks());

  it("laptop target → spawn_session message carries model + thinkingLevel", () => {
    const { actions, send } = setup([makeMachine()]);
    actions.handleStartNewSession({
      machineId: "mac-laptop",
      cwd: "/proj",
      prompt: "go",
      model: "anthropic/claude-opus-4-8",
      thinkingLevel: "high",
    });
    const payload = send.mock.calls[0]![0];
    expect(payload.type).toBe("spawn_session");
    expect(payload.cwd).toBe("/proj");
    expect(payload.machineId).toBe("mac-laptop");
    expect(payload.prompt).toBe("go");
    expect(payload.model).toBe("anthropic/claude-opus-4-8");
    expect(payload.thinkingLevel).toBe("high");
  });

  it("laptop target without overrides → no model/thinkingLevel keys (pre-#6 shape)", () => {
    const { actions, send } = setup([makeMachine()]);
    actions.handleStartNewSession({ machineId: "mac-laptop", cwd: "/proj", prompt: "go" });
    const payload = send.mock.calls[0]![0];
    expect(payload.type).toBe("spawn_session");
    expect("model" in payload).toBe(false);
    expect("thinkingLevel" in payload).toBe(false);
  });

  it("daemon target → /inject POST body carries model + thinkingLevel", async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, json: async () => ({ success: true }) }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const { actions, send } = setup([
      makeMachine({ id: "walle-daemon", label: "Daemon", role: "daemon", messageable: true }),
    ]);

    actions.handleStartNewSession({
      machineId: "walle-daemon",
      prompt: "boot up",
      model: "openai-codex/gpt-5.5",
      thinkingLevel: "medium",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("http://dash.local/api/machines/walle-daemon/message");
    expect(JSON.parse(String(init?.body))).toEqual({
      text: "boot up",
      model: "openai-codex/gpt-5.5",
      thinkingLevel: "medium",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("daemon target without overrides → body is just { text } (pre-#6 shape)", async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, json: async () => ({ success: true }) }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const { actions } = setup([
      makeMachine({ id: "walle-daemon", role: "daemon", messageable: true }),
    ]);

    actions.handleStartNewSession({ machineId: "walle-daemon", prompt: "boot up" });

    const [, init] = fetchSpy.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({ text: "boot up" });
  });
});
