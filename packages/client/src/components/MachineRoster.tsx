/**
 * MachineRoster — the left-sidebar list of configured machines.
 *
 * Lives ABOVE the existing session list when the operator has
 * configured at least one machine. Renders nothing when the roster is
 * empty (single-machine / upstream installs) so the existing sidebar
 * layout is byte-identical for users who haven't opted in.
 *
 * Each card:
 *   [accent-square 18px]  Label                  [status-dot]  Nsess
 *                         machine-id · role
 *
 * Behavior:
 *   - Click toggles a filter on the session list (App owns the
 *     selectedMachineId state). Clicking the active card clears it.
 *   - Active card draws an outline ring (matches Linear-style focus).
 *   - 0 sessions AND offline → 60% opacity (dimmer "dormant" look).
 *   - Hover reveals a kebab `…` — purely visual stub. Phase 4 wires
 *     spawn / wake / remove actions to it.
 *
 * See change: walle-multi-machine (Phase 2 — machine roster UI).
 */
import { Icon } from "@mdi/react";
import { mdiDotsHorizontal } from "@mdi/js";
import type { MachineRosterEntry, MachineStatus } from "../hooks/useMachineRoster.js";

export interface MachineRosterProps {
  machines: MachineRosterEntry[];
  /** When set, the matching card draws its active outline ring. */
  selectedMachineId?: string | null;
  /**
   * Called when the operator clicks a card. Receives the clicked
   * machine id, or `null` if the click cleared the active selection
   * (re-clicking the currently-selected card).
   */
  onMachineSelect: (id: string | null) => void;
}

// Status dot palette. Kept inline because these three colors are
// roster-only — the chip/card variants of the same identity surface
// use a different vocabulary (accent rail, not status). See mockup
// `mockups/walle-multi-machine/index.html` line 256-266.
const STATUS_DOT_COLOR: Record<MachineStatus, string> = {
  online: "#5ed09a",
  idle: "#b9b9c0",
  offline: "#6a6a72",
  // Phase 4 — host configured but TCP probe fails. Until then the
  // server never emits this status; we still need a swatch so the
  // dot never collapses to undefined at runtime.
  unreachable: "#d97757",
};

export function MachineRoster({
  machines,
  selectedMachineId,
  onMachineSelect,
}: MachineRosterProps) {
  // Empty roster = framework default. The operator hasn't configured
  // one (or hasn't yet finished `wall-e install`). Render nothing so
  // the legacy single-machine sidebar layout is unchanged.
  if (machines.length === 0) return null;

  return (
    <div
      data-testid="machine-roster"
      className="flex flex-col gap-2 px-2 py-3 border-b border-[var(--border-secondary)]"
    >
      <div className="px-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
        Machines
      </div>
      {machines.map((m) => (
        <MachineRosterCard
          key={m.id}
          machine={m}
          active={selectedMachineId === m.id}
          onClick={() =>
            onMachineSelect(selectedMachineId === m.id ? null : m.id)
          }
        />
      ))}
    </div>
  );
}

interface CardProps {
  machine: MachineRosterEntry;
  active: boolean;
  onClick: () => void;
}

function MachineRosterCard({ machine, active, onClick }: CardProps) {
  const status: MachineStatus = machine.status ?? "offline";
  const dimmed = machine.sessionCount === 0 && status === "offline";
  const accent = machine.accent ?? "var(--text-tertiary)";
  const dotColor = STATUS_DOT_COLOR[status] ?? STATUS_DOT_COLOR.offline;

  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="machine-roster-card"
      data-machine-id={machine.id}
      data-active={active ? "true" : "false"}
      data-status={status}
      title={`${machine.label} (${machine.id})${
        machine.role ? ` — ${machine.role}` : ""
      }`}
      className={`group relative w-full grid grid-cols-[18px_1fr_auto] items-center gap-2 rounded-md px-2 py-2 text-left transition-colors ${
        active
          ? "bg-[var(--bg-tertiary)] ring-1 ring-[var(--border-focus,#5fb4a4)]"
          : "hover:bg-[var(--bg-tertiary)]/60"
      } ${dimmed ? "opacity-60" : ""}`}
      style={
        active
          ? {
              // Fallback for installs where --border-focus isn't
              // themed: use the machine accent so the active state is
              // always visible. Tailwind ring color overrides this.
              boxShadow: `0 0 0 1px ${accent}`,
            }
          : undefined
      }
    >
      <span
        aria-hidden="true"
        data-testid="machine-roster-accent"
        className="block h-[18px] w-[18px] rounded-[4px]"
        style={{ backgroundColor: accent }}
      />

      <span className="min-w-0">
        <span
          className="block truncate text-[13px] font-medium leading-tight text-[var(--text-primary)]"
          data-testid="machine-roster-label"
        >
          {machine.label}
        </span>
        <span
          className="block truncate text-[11px] leading-tight text-[var(--text-tertiary)]"
          data-testid="machine-roster-sub"
        >
          {machine.id}
          {machine.role ? <span className="opacity-70"> · {machine.role}</span> : null}
        </span>
      </span>

      <span className="flex items-center gap-1.5 text-[11px] tabular-nums text-[var(--text-tertiary)]">
        <span
          aria-hidden="true"
          data-testid="machine-roster-dot"
          className="inline-block h-[6px] w-[6px] rounded-full"
          style={{ backgroundColor: dotColor }}
        />
        <span data-testid="machine-roster-count">{machine.sessionCount}</span>
      </span>

      <span
        aria-hidden="true"
        data-testid="machine-roster-kebab"
        className="absolute right-1 top-1 hidden h-5 w-5 items-center justify-center rounded text-[var(--text-tertiary)] group-hover:flex"
      >
        <Icon path={mdiDotsHorizontal} size={0.55} />
      </span>
    </button>
  );
}
