/**
 * Tests for `useMachineRoster`.
 *
 * What we cover:
 *   1. Fetches on mount.
 *   2. Polls every `pollMs` via setInterval.
 *   3. Replaces the cached list when a `machines_changed` WS frame
 *      arrives (full replace, not merge).
 *   4. Ignores unrelated / malformed WS frames.
 *   5. Unsubscribes from the WS on unmount.
 *   6. Surfaces HTTP errors.
 *   7. `refetch()` triggers an extra round-trip.
 *
 * Note on timers: vi.useFakeTimers() blocks the microtask queue, so
 * the polling test uses `advanceTimersByTimeAsync` (which flushes
 * microtasks between each timer tick). All other tests run with real
 * timers — they only need promise-tick coverage.
 *
 * See change: walle-multi-machine.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import {
  useMachineRoster,
  type MachineRosterEntry,
  type MachineSubscribe,
} from "../useMachineRoster.js";

function makeMachine(over: Partial<MachineRosterEntry> = {}): MachineRosterEntry {
  return {
    id: "walle-daemon",
    label: "wall-e daemon",
    addedAt: "2026-06-17T00:00:00Z",
    status: "online",
    sessionCount: 2,
    ...over,
  };
}

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  } as unknown as Response;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useMachineRoster", () => {
  it("fetches once on mount and exposes the list + isLoading flag", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ machines: [makeMachine()] }));

    const subscribe: MachineSubscribe = () => () => {};

    const { result } = renderHook(() => useMachineRoster(subscribe, 0));

    // Synchronous post-mount state — before the fetch promise resolves.
    expect(result.current.isLoading).toBe(true);
    expect(result.current.machines).toEqual([]);

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.machines).toHaveLength(1);
    expect(result.current.machines[0].id).toBe("walle-daemon");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/\/api\/machines$/));
  });

  it("polls every pollMs", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ machines: [] }));

    const subscribe: MachineSubscribe = () => () => {};
    renderHook(() => useMachineRoster(subscribe, 1_000));

    // Initial fetch — flush microtasks so the awaited json() settles.
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("replaces the cached list when a machines_changed WS frame arrives", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ machines: [makeMachine({ id: "a", sessionCount: 1 })] }),
    );

    // Capture the handler the hook registers so we can fire the frame
    // synchronously inside `act`.
    let captured: ((msg: unknown) => void) | null = null;
    const subscribe: MachineSubscribe = (handler) => {
      captured = handler as (msg: unknown) => void;
      return () => {
        captured = null;
      };
    };

    const { result } = renderHook(() => useMachineRoster(subscribe, 0));

    await waitFor(() => expect(result.current.machines).toHaveLength(1));
    expect(captured).not.toBeNull();

    const newList: MachineRosterEntry[] = [
      makeMachine({ id: "b", label: "mac-work", status: "idle", sessionCount: 0 }),
      makeMachine({ id: "c", label: "arch-personal", status: "offline", sessionCount: 0 }),
    ];

    act(() => {
      captured!({ type: "machines_changed", machines: newList });
    });

    expect(result.current.machines).toHaveLength(2);
    expect(result.current.machines.map((m) => m.id)).toEqual(["b", "c"]);
  });

  it("ignores unrelated WS frames", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ machines: [makeMachine()] }),
    );

    let captured: ((msg: unknown) => void) | null = null;
    const subscribe: MachineSubscribe = (handler) => {
      captured = handler as (msg: unknown) => void;
      return () => {};
    };

    const { result } = renderHook(() => useMachineRoster(subscribe, 0));
    await waitFor(() => expect(result.current.machines).toHaveLength(1));

    act(() => {
      captured!({ type: "event", sessionId: "x" });
      captured!({ type: "machines_changed" }); // missing `machines` array
    });

    // Same list — the malformed frame was rejected by the type guard.
    expect(result.current.machines).toHaveLength(1);
    expect(result.current.machines[0].id).toBe("walle-daemon");
  });

  it("unsubscribes the WS handler on unmount", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ machines: [] }),
    );
    const unsubscribe = vi.fn();
    const subscribe: MachineSubscribe = () => unsubscribe;

    const { unmount, result } = renderHook(() => useMachineRoster(subscribe, 0));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("sets an error on non-2xx response and stops loading", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as Response);

    const subscribe: MachineSubscribe = () => () => {};
    const { result } = renderHook(() => useMachineRoster(subscribe, 0));

    await waitFor(() => expect(result.current.error).toBe("HTTP 500"));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.machines).toEqual([]);
  });

  it("refetch() triggers another fetch on demand", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ machines: [] }));

    const subscribe: MachineSubscribe = () => () => {};
    const { result } = renderHook(() => useMachineRoster(subscribe, 0));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      result.current.refetch();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("accepts ApiResponse-wrapped `{ data: { machines } }` shape", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ success: true, data: { machines: [makeMachine()] } }),
    );

    const subscribe: MachineSubscribe = () => () => {};
    const { result } = renderHook(() => useMachineRoster(subscribe, 0));

    await waitFor(() => expect(result.current.machines).toHaveLength(1));
  });
});
