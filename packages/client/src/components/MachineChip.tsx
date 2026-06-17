/**
 * MachineChip — compact identity badge for `session.machine`.
 *
 * Renders nothing when the session has no machine identity (upstream /
 * single-machine installs) so the existing card layout is byte-identical.
 * When present, shows a small accent-color square + the machine label,
 * with a hover title revealing the opaque machineId.
 *
 * Variants:
 *   - "card"     — used in SessionCard near the name. Tight, 10 px font,
 *                  truncates the label to ~12 chars before ellipsis.
 *   - "folder"   — used in SessionList folder headers. Smaller, secondary
 *                  text color, accent-square only when no label.
 *   - "header"   — used in session detail header. Larger label + accent.
 *
 * See change: walle-multi-machine (Phase 2 — machine roster UI).
 */
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";

export interface MachineChipProps {
  machine: NonNullable<DashboardSession["machine"]> | undefined | null;
  variant?: "card" | "folder" | "header";
  className?: string;
}

export function MachineChip({ machine, variant = "card", className = "" }: MachineChipProps) {
  if (!machine || !machine.id) return null;

  const label = machine.label ?? machine.id;
  const accent = machine.accent ?? "var(--text-tertiary)";

  // Variant geometry. Kept inline (single source of truth) so a card and
  // header chip render at consistent visual weight relative to each other.
  const sizing =
    variant === "header"
      ? "text-[11px] px-2 py-0.5 gap-1.5"
      : variant === "folder"
        ? "text-[10px] px-1 py-0 gap-1"
        : "text-[10px] px-1.5 py-0 gap-1";

  return (
    <span
      className={`inline-flex items-center rounded border border-[var(--border-secondary)] bg-[var(--bg-tertiary)]/50 text-[var(--text-secondary)] font-medium flex-shrink-0 ${sizing} ${className}`}
      title={`Machine: ${machine.id}${machine.label ? ` (${machine.label})` : ""}`}
      data-testid="machine-chip"
      data-machine-id={machine.id}
    >
      <span
        aria-hidden="true"
        className="inline-block rounded-[2px] flex-shrink-0"
        style={{
          backgroundColor: accent,
          width: variant === "header" ? "8px" : "6px",
          height: variant === "header" ? "8px" : "6px",
        }}
      />
      <span className="truncate max-w-[120px]">{label}</span>
    </span>
  );
}
