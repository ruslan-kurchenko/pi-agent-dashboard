/**
 * ViewingFromBar — the SOTA dashboard footer (32px, `--bg-nav`).
 *
 * "Viewing from {serving-device chip} via {host:port}" on the left
 * (the VS Code remote pattern), keyboard hints + runtime tag on the
 * right. Replaces the removed ServerSelector's "where am I" role:
 * transport is read from the active WS URL's host:port (passed by
 * ClientShell) and the serving device is resolved from the roster.
 *
 * Renders an inline machine chip (accent square + label) rather than
 * importing MachineChip — that component is owned/restyled by
 * ClientSessions, so this stays decoupled. See design-spec §B6.
 *
 * Owned by ClientShell. See change: dashboard-sota-multi-machine.
 */
import React, { useMemo } from "react";
import type { MachineRosterEntry } from "../hooks/useMachineRoster.js";
import type { LaunchSource } from "../hooks/useLaunchSource.js";

export interface ViewingFromBarProps {
  machines: MachineRosterEntry[];
  /** Host of the active dashboard server (from the WS URL). */
  host: string;
  /** Port of the active dashboard server (from the WS URL). */
  port: number;
  /** Server launch source (`/api/health`); shown as the runtime tag. */
  launchSource?: LaunchSource | null;
  /** Open the ⌘K command palette (mirrors the topbar affordance). */
  onOpenPalette?: () => void;
}

export function ViewingFromBar({
  machines,
  host,
  port,
  launchSource,
  onOpenPalette,
}: ViewingFromBarProps) {
  // Serving device: the machine the dashboard is served from. Prefer a
  // host match, then the messageable local daemon, then any daemon, then
  // the first configured machine.
  const serving = useMemo(
    () =>
      machines.find((m) => m.host && m.host === host) ??
      machines.find((m) => m.messageable) ??
      machines.find((m) => m.role === "daemon") ??
      machines[0],
    [machines, host],
  );

  const accent = serving?.accent ?? "var(--m-never)";
  const servingLabel = serving
    ? serving.role
      ? `${serving.label} · ${serving.role}`
      : serving.label
    : "this device";

  return (
    <div
      className="app-footer flex items-center gap-[14px] px-[14px] bg-[var(--bg-nav)] border-t border-[var(--border-secondary)] text-[10px] text-[var(--text-tertiary)]"
      data-testid="viewing-from-bar"
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-[var(--text-tertiary)]">Viewing from</span>
        <span
          className="inline-flex items-center gap-1 rounded-[var(--r-chip)] border border-[var(--border-subtle)] bg-[var(--bg-hover)] px-1.5 py-px text-[10px] font-medium text-[var(--text-secondary)] max-w-[220px] truncate"
          data-testid="viewing-from-chip"
          title={servingLabel}
        >
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 rounded-[2px] shrink-0"
            style={{ background: accent }}
          />
          <span className="truncate">{servingLabel}</span>
        </span>
        <span className="text-[var(--text-tertiary)] ml-1.5">via</span>
        <span className="font-mono text-[var(--text-tertiary)] truncate" title={`${host}:${port}`}>
          {host}:{port}
        </span>
      </div>

      <div className="ml-auto flex items-center gap-[14px]">
        <button
          type="button"
          onClick={onOpenPalette}
          className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
          title="Command palette"
        >
          <span className="wt-kbd">⌘K</span> palette
        </button>
        <span className="text-[var(--text-tertiary)]">
          <span className="wt-kbd">⌘/</span> search
        </span>
        {launchSource && (
          <span className="font-mono text-[var(--text-tertiary)]">{launchSource}</span>
        )}
      </div>
    </div>
  );
}
