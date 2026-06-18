/**
 * TopBar — the SOTA dashboard chrome top row (40px, `--bg-nav`).
 *
 * Replaces the old inline ServerSelector header. Left→right: brand
 * (dot + wordmark), operator pill (→ Settings), aggregate live stats
 * (online / streaming / needs-input / $today computed from the live
 * sessions + machine roster), ⌘K palette icon, a one-tap sun/moon
 * theme toggle, and the Settings gear.
 *
 * Stats are the home for the aggregate cost-of-day (the per-session
 * TokenStatsBar still lives in the detail pane). See design-spec §B.2.
 *
 * Owned by ClientShell. See change: dashboard-sota-multi-machine.
 */
import React, { useMemo } from "react";
import { useThemeContext } from "./ThemeProvider.js";
import type { MachineRosterEntry } from "../hooks/useMachineRoster.js";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";

export interface TopBarProps {
  machines: MachineRosterEntry[];
  sessions: DashboardSession[];
  /** Open the ⌘K command palette. */
  onOpenPalette: () => void;
  /** Open the Settings panel (also the operator-pill action for v1). */
  onOpenSettings: () => void;
  /**
   * Clicking the "needs input" stat. ClientShell wires this to select
   * the first session awaiting `ask_user`. Only rendered when count>0.
   */
  onNeedsInput?: () => void;
}

export function TopBar({
  machines,
  sessions,
  onOpenPalette,
  onOpenSettings,
  onNeedsInput,
}: TopBarProps) {
  const { resolved, setPreference } = useThemeContext();

  const stats = useMemo(() => {
    const total = machines.length;
    const online = machines.filter((m) => m.status === "online").length;
    let streaming = 0;
    let needsInput = 0;
    let today = 0;
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const startMs = startOfDay.getTime();
    for (const s of sessions) {
      if (s.status === "streaming") streaming += 1;
      if (s.currentTool === "ask_user" && s.status !== "ended") needsInput += 1;
      const when = s.lastActivityAt ?? s.startedAt;
      if (when >= startMs) today += s.cost ?? 0;
    }
    return { total, online, streaming, needsInput, today };
  }, [machines, sessions]);

  const toggleTheme = () =>
    setPreference(resolved === "dark" ? "light" : "dark");

  return (
    <div
      className="app-topbar flex items-center gap-[14px] px-[14px] bg-[var(--bg-nav)] border-b border-[var(--border-secondary)]"
      data-testid="topbar"
    >
      {/* Brand */}
      <div
        className="flex items-center gap-2 text-[13px] font-semibold text-[var(--text-primary)] select-none"
        style={{ letterSpacing: "0.01em", fontFamily: "var(--f-display)" }}
      >
        <span
          aria-hidden="true"
          className="h-2 w-2 rounded-full"
          style={{
            background: "var(--m-daemon)",
            boxShadow: "0 0 8px rgba(95,180,164,0.35)",
          }}
        />
        wall-e
      </div>

      {/* Operator pill — opens Settings (single-operator → Settings menu). */}
      <button
        type="button"
        onClick={onOpenSettings}
        title="Operator — open settings"
        data-testid="topbar-operator"
        className="flex items-center gap-1.5 rounded-full px-2 py-[3px] text-[11px] text-[var(--text-secondary)] bg-[var(--bg-elev)] border border-[var(--border-subtle)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface)] transition-colors"
      >
        <span
          aria-hidden="true"
          className="flex h-[14px] w-[14px] items-center justify-center rounded-full text-[9px] font-bold text-[#1a1a1a]"
          style={{
            background:
              "linear-gradient(135deg, var(--m-arch), var(--m-daemon))",
          }}
        >
          R
        </span>
        Ruslan
        <span aria-hidden="true" className="text-[10px] text-[var(--text-tertiary)]">
          ▾
        </span>
      </button>

      {/* Aggregate live stats */}
      <div className="ml-auto flex items-center gap-5 text-[11px] text-[var(--text-tertiary)]">
        <span data-testid="stat-online">
          <b className="num font-medium text-[var(--text-primary)]">{stats.online}</b>
          /{stats.total} online
        </span>
        <span data-testid="stat-streaming">
          <b className="num font-medium text-[var(--text-primary)]">{stats.streaming}</b>{" "}
          streaming
        </span>
        {stats.needsInput > 0 && (
          <button
            type="button"
            onClick={onNeedsInput}
            data-testid="stat-needs-input"
            className="gentle-pulse cursor-pointer text-[var(--s-ask)]"
            title="Jump to the first session awaiting input"
          >
            <b className="num font-medium">{stats.needsInput}</b> needs input
          </button>
        )}
        <span data-testid="stat-today">
          $<b className="num font-medium text-[var(--text-primary)]">{stats.today.toFixed(2)}</b>{" "}
          today
        </span>
      </div>

      {/* ⌘K palette */}
      <button
        type="button"
        onClick={onOpenPalette}
        className="wt-icon-btn"
        title="Command palette (⌘K)"
        aria-label="Open command palette"
        data-testid="topbar-palette"
      >
        <span className="text-[14px] leading-none">⌘</span>
      </button>

      {/* Theme toggle (sun/moon) — one-tap dark↔light */}
      <button
        type="button"
        onClick={toggleTheme}
        className="wt-icon-btn"
        title={resolved === "dark" ? "Switch to light" : "Switch to dark"}
        aria-label="Toggle theme"
        data-testid="topbar-theme-toggle"
      >
        {resolved === "dark" ? (
          // moon
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M6 1a7 7 0 109 9A6 6 0 016 1z" />
          </svg>
        ) : (
          // sun
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <circle cx="8" cy="8" r="3" />
            <path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3.05 3.05l1.06 1.06M11.9 11.9l1.06 1.06M3.05 12.95l1.06-1.06M11.9 4.1l1.06-1.06" />
          </svg>
        )}
      </button>

      {/* Settings */}
      <button
        type="button"
        onClick={onOpenSettings}
        className="wt-icon-btn"
        title="Settings"
        aria-label="Open settings"
        data-testid="topbar-settings"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <circle cx="8" cy="8" r="2" />
          <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.4 1.4M11.55 11.55l1.4 1.4M3.05 12.95l1.4-1.4M11.55 4.45l1.4-1.4" />
        </svg>
      </button>
    </div>
  );
}
