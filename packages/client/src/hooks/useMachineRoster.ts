/**
 * useMachineRoster — load + keep fresh the dashboard's machine roster.
 *
 * The roster is the persisted list of configured machines (from
 * `~/.pi/dashboard.json#machines`, see shared/config.ts MachineEntry)
 * decorated server-side with liveness state (status + sessionCount +
 * lastSeenAt) computed at request time from session activity.
 *
 * Update strategy:
 *   1. Initial `GET /api/machines` on mount.
 *   2. setInterval re-fetch every `pollMs` (default 5_000ms) — defensive
 *      fallback in case a WS frame is dropped during reconnect.
 *   3. Subscribe to the existing WS via the supplied `subscribe`
 *      function. A `machines_changed` frame REPLACES the cached list
 *      with `frame.machines` immediately (no extra round-trip).
 *
 * Caller is responsible for owning the WS subscription helper (the
 * dashboard exposes `onMessage` from `useWebSocket`). This indirection
 * keeps the hook trivially testable with a fake subscribe + a stubbed
 * `fetch`.
 *
 * See change: walle-multi-machine (Phase 2 — machine roster UI).
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { getApiBase } from "../lib/api-context.js";
import type { ServerToBrowserMessage } from "@blackbelt-technology/pi-dashboard-shared/browser-protocol.js";
import type {
  MachineRosterEntry,
  MachineStatus,
  MachinesChangedMessage,
} from "@blackbelt-technology/pi-dashboard-shared/rest-api.js";

// Re-export so downstream consumers (MachineRoster.tsx, App.tsx, tests)
// have one stable import path for the roster shape. The truth lives in
// shared/rest-api.ts; this module is the client-side seam.
// See change: walle-multi-machine.
export type { MachineRosterEntry, MachineStatus };

/** Returned by `useWebSocket().onMessage`. */
export type MachineSubscribe = (
  handler: (msg: ServerToBrowserMessage) => void,
) => () => void;

export interface UseMachineRosterResult {
  machines: MachineRosterEntry[];
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

const DEFAULT_POLL_MS = 5_000;

/**
 * Structural type-guard for the `machines_changed` WS frame. Cheaper
 * than a full schema check and survives any future additive field
 * additions on the server side.
 */
function isMachinesChanged(msg: unknown): msg is MachinesChangedMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as { type?: unknown }).type === "machines_changed" &&
    Array.isArray((msg as { machines?: unknown }).machines)
  );
}

export function useMachineRoster(
  subscribe: MachineSubscribe,
  pollMs: number = DEFAULT_POLL_MS,
): UseMachineRosterResult {
  const [machines, setMachines] = useState<MachineRosterEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const fetchOnce = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`${getApiBase()}/api/machines`);
      if (!mountedRef.current) return;
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        setIsLoading(false);
        return;
      }
      const body: unknown = await res.json();
      if (!mountedRef.current) return;
      // Tolerate both the canonical `ApiResponse<{ machines }>` and a
      // bare `{ machines }` shape so future server churn doesn't break
      // the UI. List is the only thing we care about here.
      const list = extractMachines(body);
      setMachines(list);
      setIsLoading(false);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : "Network error");
      setIsLoading(false);
    }
  }, []);

  // Initial fetch + polling. Polling is a defensive fallback for
  // dropped WS frames during reconnect; on a healthy socket the WS
  // path beats the timer every time.
  useEffect(() => {
    mountedRef.current = true;
    fetchOnce();
    if (pollMs <= 0) return () => { mountedRef.current = false; };
    const id = setInterval(fetchOnce, pollMs);
    return () => {
      mountedRef.current = false;
      clearInterval(id);
    };
  }, [fetchOnce, pollMs]);

  // WS subscription. `machines_changed` is authoritative — replace the
  // whole list, do not merge (server already computed status from
  // live session activity).
  useEffect(() => {
    const unsubscribe = subscribe((msg) => {
      if (isMachinesChanged(msg)) {
        setMachines(msg.machines);
        setIsLoading(false);
      }
    });
    return unsubscribe;
  }, [subscribe]);

  return { machines, isLoading, error, refetch: fetchOnce };
}

function extractMachines(body: unknown): MachineRosterEntry[] {
  if (!body || typeof body !== "object") return [];
  // ApiResponse shape: `{ success, data: { machines: [...] } }`
  const data = (body as { data?: unknown }).data;
  if (data && typeof data === "object") {
    const m = (data as { machines?: unknown }).machines;
    if (Array.isArray(m)) return m as MachineRosterEntry[];
  }
  // Bare shape: `{ machines: [...] }`
  const m = (body as { machines?: unknown }).machines;
  if (Array.isArray(m)) return m as MachineRosterEntry[];
  return [];
}
