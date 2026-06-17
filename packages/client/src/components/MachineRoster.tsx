/**
 * MachineRoster — permanent sidebar roster of configured agent hosts.
 *
 * Visual contract: mockup `mockups/walle-multi-machine/index.html`.
 * Key design cues (Linear March-2026 + Tailscale admin + Docker rows):
 *   - 3 px accent left-rail per card (operator's curated color)
 *   - Running dot glows; idle dot is hollow ring; offline is solid muted
 *   - Offline + 0 sessions → 55% opacity, hover lifts to 90%
 *   - Background is dimmer than content (--bg-nav / warm-gray)
 *   - Spacing: 10 px padding inside card, 4 px gap between cards
 *
 * Renders nothing when `machines` is empty (framework default).
 *
 * See change: walle-multi-machine (Phase 2 — machine roster UI).
 */
import { Icon } from "@mdi/react";
import { mdiDotsHorizontal } from "@mdi/js";
import type { MachineRosterEntry, MachineStatus } from "../hooks/useMachineRoster.js";

export interface MachineRosterProps {
  machines: MachineRosterEntry[];
  selectedMachineId?: string | null;
  onMachineSelect: (id: string | null) => void;
}

export function MachineRoster({
  machines,
  selectedMachineId,
  onMachineSelect,
}: MachineRosterProps) {
  if (machines.length === 0) return null;

  return (
    <div
      data-testid="machine-roster"
      style={{
        padding: "14px 12px 12px",
        borderBottom: "1px solid rgba(255,255,255,0.075)",
      }}
    >
      {/* Section header — LINEAR style: tiny uppercase, wide tracking */}
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          padding: "0 4px 8px",
          color: "var(--text-tertiary, #707078)",
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          fontWeight: 600,
        }}
      >
        Machines
      </div>

      {/* Cards */}
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
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
  const accent = machine.accent ?? "#4a4a52";

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
      style={{
        position: "relative",
        display: "grid",
        gridTemplateColumns: "24px 1fr auto",
        alignItems: "center",
        gap: 10,
        padding: "10px 10px 10px 14px",
        borderRadius: 8,
        marginBottom: 0,
        cursor: "pointer",
        border: "none",
        textAlign: "left" as const,
        width: "100%",
        fontFamily: "inherit",
        transition: "background 120ms, opacity 150ms",
        background: active ? "rgba(255,255,255,0.04)" : "transparent",
        opacity: dimmed ? 0.55 : 1,
        ...(active
          ? {
              boxShadow: `inset 0 0 0 1px ${accent}40`,
            }
          : {}),
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.background =
          "rgba(255,255,255,0.025)";
        if (dimmed) (e.currentTarget as HTMLElement).style.opacity = "0.9";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.background = active
          ? "rgba(255,255,255,0.04)"
          : "transparent";
        if (dimmed) (e.currentTarget as HTMLElement).style.opacity = "0.55";
      }}
    >
      {/* ---- Accent left-rail ---- */}
      <span
        aria-hidden="true"
        style={{
          position: "absolute",
          left: 0,
          top: 6,
          bottom: 6,
          width: 3,
          borderRadius: 3,
          background: accent,
        }}
      />

      {/* ---- Icon square ---- */}
      <span
        aria-hidden="true"
        data-testid="machine-roster-accent"
        style={{
          width: 24,
          height: 24,
          borderRadius: 6,
          background: accent,
          opacity: 0.85,
          color: "#15151a",
          fontSize: 11,
          fontWeight: 700,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily:
            "'JetBrains Mono', ui-monospace, Menlo, monospace",
        }}
      >
        {(machine.label ?? machine.id).charAt(0).toUpperCase()}
      </span>

      {/* ---- Meta: label + id · role ---- */}
      <span style={{ minWidth: 0 }}>
        <span
          data-testid="machine-roster-label"
          style={{
            display: "block",
            color: "var(--text-primary, #ececef)",
            fontSize: 13,
            fontWeight: 500,
            marginBottom: 2,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            lineHeight: 1.2,
          }}
        >
          {machine.label}
        </span>
        <span
          data-testid="machine-roster-sub"
          style={{
            display: "block",
            color: "var(--text-tertiary, #707078)",
            fontSize: 11,
            lineHeight: 1.2,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {machine.id}
          {machine.role ? (
            <span style={{ opacity: 0.7 }}> · {machine.role}</span>
          ) : null}
        </span>
      </span>

      {/* ---- Status + count ---- */}
      <span
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
          gap: 2,
          color: "var(--text-tertiary, #707078)",
          fontSize: 10,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
          }}
        >
          <StatusDot status={status} />
          <span
            data-testid="machine-roster-count"
            style={{
              color: "var(--text-primary, #ececef)",
              fontWeight: 500,
              fontSize: 12,
            }}
          >
            {machine.sessionCount}
          </span>
        </span>
      </span>

      {/* ---- Kebab (visual stub, Phase 4 wires actions) ---- */}
      <span
        aria-hidden="true"
        data-testid="machine-roster-kebab"
        className="machine-roster-kebab"
        style={{
          position: "absolute",
          right: 4,
          top: 4,
          width: 20,
          height: 20,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 4,
          color: "var(--text-tertiary, #707078)",
          display: "none",
        }}
      >
        <Icon path={mdiDotsHorizontal} size={0.55} />
      </span>

      {/* Show kebab on hover via a tiny <style> scoped by nesting */}
      <style>{`
        [data-testid="machine-roster-card"]:hover .machine-roster-kebab {
          display: flex !important;
        }
      `}</style>
    </button>
  );
}

/** Status dot with mockup-accurate subtlety. */
function StatusDot({ status }: { status: MachineStatus }) {
  const base: React.CSSProperties = {
    width: 6,
    height: 6,
    borderRadius: "50%",
    flexShrink: 0,
  };

  switch (status) {
    case "online":
      return (
        <span
          aria-hidden="true"
          data-testid="machine-roster-dot"
          style={{
            ...base,
            background: "#5ed09a",
            boxShadow: "0 0 6px rgba(94,208,154,0.35)",
          }}
        />
      );
    case "idle":
      return (
        <span
          aria-hidden="true"
          data-testid="machine-roster-dot"
          style={{
            ...base,
            background: "transparent",
            border: "1px solid #b9b9c0",
          }}
        />
      );
    case "unreachable":
      return (
        <span
          aria-hidden="true"
          data-testid="machine-roster-dot"
          style={{
            ...base,
            background: "#e6a55a",
          }}
        />
      );
    case "offline":
    default:
      return (
        <span
          aria-hidden="true"
          data-testid="machine-roster-dot"
          style={{
            ...base,
            background: "#6a6a72",
          }}
        />
      );
  }
}
