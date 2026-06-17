/**
 * Generic localStorage-backed collapsible column state.
 * Each column gets its own storage key so roster and sessions
 * collapse/expand independently with persistence across reloads.
 *
 * See change: walle-multi-machine (collapsible columns).
 */
import { useState, useCallback } from "react";

export interface CollapsibleColumnState {
  collapsed: boolean;
  toggle: () => void;
  expand: () => void;
  collapse: () => void;
}

function readBool(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return raw === "true";
  } catch {
    return fallback;
  }
}

export function useCollapsibleColumn(
  storageKey: string,
  defaultCollapsed = false,
): CollapsibleColumnState {
  const [collapsed, setCollapsed] = useState(() =>
    readBool(storageKey, defaultCollapsed),
  );

  const persist = useCallback(
    (next: boolean) => {
      try {
        localStorage.setItem(storageKey, String(next));
      } catch {
        /* noop */
      }
    },
    [storageKey],
  );

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      persist(next);
      return next;
    });
  }, [persist]);

  const expand = useCallback(() => {
    setCollapsed(false);
    persist(false);
  }, [persist]);

  const collapse = useCallback(() => {
    setCollapsed(true);
    persist(true);
  }, [persist]);

  return { collapsed, toggle, expand, collapse };
}
