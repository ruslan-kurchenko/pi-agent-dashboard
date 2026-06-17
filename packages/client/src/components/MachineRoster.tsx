/**
 * MachineRoster — permanent sidebar roster of configured agent hosts.
 *
 * Visual contract: mockup `mockups/walle-multi-machine/index.html`.
 * Key design cues (Linear March-2026 + Tailscale admin + Docker rows):
 *   - 3 px accent left-rail per card (operator's curated color)
 *   - 24px icon square with 2-letter abbreviation, accent bg
 *   - Status line below name ("● running · 4m ago")
 *   - Session count right-aligned with "sessions" label
 *   - Running dot glows; idle dot is hollow ring; offline is solid muted
 *   - Offline + 0 sessions → 55% opacity, hover lifts to 90%
 *
 * Renders nothing when `machines` is empty (framework default).
 *
 * See change: walle-multi-machine.
 */
import { Icon } from "@mdi/react";
import { mdiDotsHorizontal } from "@mdi/js";
import type { MachineRosterEntry, MachineStatus } from "../hooks/useMachineRoster.js";

export interface MachineRosterProps {
  machines: MachineRosterEntry[];
  selectedMachineId?: string | null;
  onMachineSelect: (id: string | null) => void;
}

/** Derive a 2-letter abbreviation for the icon square. */
function abbrev(label: string, role?: string): string {
  if (role === "daemon") return "wd";
  const words = label.replace(/[()[\]]/g, "").trim().split(/\s+/);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toLowerCase();
  }
  return label.slice(0, 2).toLowerCase();
}

/** Human-readable relative time. */
function timeAgo(iso?: string): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const STATUS_LABELS: Record<MachineStatus, string> = {
  online: "running",
  idle: "idle",
  offline: "offline",
  unreachable: "unreachable",
};

export function MachineRoster({
  machines,
  selectedMachineId,
  onMachineSelect,
}: MachineRosterProps) {
  if (machines.length === 0) return null;

  // Group by owner for multi-tenant separation.
  const grouped = groupByOwner(machines);

  return (
    <div
      data-testid="machine-roster"
      style={{
        padding: "14px 12px 12px",
        borderBottom: "1px solid rgba(255,255,255,0.075)",
      }}
    >
      {/* Section header */}
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          padding: "0 4px 10px",
          color: "var(--text-tertiary, #707078)",
          fontSize: 10,
          textTransform: "uppercase" as const,
          letterSpacing: "0.08em",
          fontWeight: 600,
        }}
      >
        <span>Machines</span>
      </div>

      {/* Cards, potentially grouped by owner */}
      {grouped.map((group) => (
        <div key={group.owner ?? "__default"}>
          {group.owner && (
            <div
              style={{
                marginTop: 10,
                marginBottom: 6,
                padding: "6px 4px 4px",
                color: "var(--text-tertiary, #707078)",
                fontSize: 10,
                textTransform: "uppercase" as const,
                letterSpacing: "0.08em",
                borderTop: "1px solid rgba(255,255,255,0.045)",
              }}
            >
              {group.owner}
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {group.machines.map((m) => (
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
      ))}
    </div>
  );
}

interface OwnerGroup {
  owner: string | null;
  machines: MachineRosterEntry[];
}

function groupByOwner(machines: MachineRosterEntry[]): OwnerGroup[] {
  // If only one owner (or none), no headers needed.
  const owners = new Set(machines.map((m) => m.owner ?? ""));
  if (owners.size <= 1) {
    return [{ owner: null, machines }];
  }
  const map = new Map<string, MachineRosterEntry[]>();
  for (const m of machines) {
    const key = m.owner ?? "";
    const arr = map.get(key) ?? [];
    arr.push(m);
    map.set(key, arr);
  }
  return Array.from(map.entries()).map(([owner, ms]) => ({
    owner: owner || null,
    machines: ms,
  }));
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
  const statusLabel = STATUS_LABELS[status] ?? "offline";
  const lastSeen = timeAgo(machine.lastSeenAt);

  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="machine-roster-card"
      data-machine-id={machine.id}
      data-active={active ? "true" : "false"}
      data-status={status}
      title={`${machine.label} (${machine.id})${machine.role ? ` — ${machine.role}` : ""}`}
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: "8px 10px 8px 14px",
        borderRadius: 8,
        cursor: "pointer",
        border: "none",
        textAlign: "left" as const,
        width: "100%",
        fontFamily: "inherit",
        transition: "background 120ms, opacity 150ms",
        background: active ? "rgba(255,255,255,0.04)" : "transparent",
        opacity: dimmed ? 0.55 : 1,
        ...(active ? { boxShadow: `inset 0 0 0 1px ${accent}40` } : {}),
      }}
      onMouseEnter={(e) => {
        const el = e.currentTarget as HTMLElement;
        el.style.background = "rgba(255,255,255,0.03)";
        if (dimmed) el.style.opacity = "0.9";
      }}
      onMouseLeave={(e) => {
        const el = e.currentTarget as HTMLElement;
        el.style.background = active ? "rgba(255,255,255,0.04)" : "transparent";
        if (dimmed) el.style.opacity = "0.55";
      }}
    >
      {/* Accent left-rail */}
      <span aria-hidden="true" style={{
        position: "absolute", left: 0, top: 6, bottom: 6,
        width: 3, borderRadius: 3, background: accent,
      }} />

      {/* Row 1: icon + name */}
      <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <span
          aria-hidden="true"
          data-testid="machine-roster-accent"
          style={{
            width: 22, height: 22, borderRadius: 5,
            background: accent, opacity: 0.85,
            color: "#15151a", fontSize: 9, fontWeight: 700,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontFamily: "'Cascadia Code', 'JetBrains Mono', ui-monospace, monospace",
            textTransform: "uppercase" as const, letterSpacing: "-0.03em",
            flexShrink: 0,
          }}
        >
          {abbrev(machine.label, machine.role)}
        </span>
        <span data-testid="machine-roster-label" style={{
          flex: 1, minWidth: 0,
          color: "var(--text-primary, #eaeaec)",
          fontSize: 13, fontWeight: 500, lineHeight: 1.2,
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }}>
          {machine.label}
        </span>
      </span>

      {/* Row 2: ● status · time (left)  ——  count (right) */}
      <span data-testid="machine-roster-sub" style={{
        display: "flex", alignItems: "center", gap: 5,
        paddingLeft: 30,
        color: "var(--text-tertiary, #6a6a74)", fontSize: 11, lineHeight: 1.2,
      }}>
        <StatusDot status={status} />
        <span>{statusLabel}</span>
        {lastSeen && (
          <><span style={{ opacity: 0.35 }}>·</span><span>{lastSeen}</span></>
        )}
        <span style={{ flex: 1 }} />
        <span data-testid="machine-roster-count" style={{
          color: machine.sessionCount > 0 ? "var(--text-secondary, #a0a0a8)" : "var(--text-muted, #44444c)",
          fontSize: 11, fontVariantNumeric: "tabular-nums", flexShrink: 0,
        }}>
          {machine.sessionCount > 0
            ? `${machine.sessionCount} ${machine.sessionCount === 1 ? "session" : "sessions"}`
            : "—"}
        </span>
      </span>

      {/* Kebab (hover-only) */}
      <span aria-hidden="true" data-testid="machine-roster-kebab" className="machine-roster-kebab" style={{
        position: "absolute", right: 4, top: 4, width: 20, height: 20,
        alignItems: "center", justifyContent: "center", borderRadius: 4,
        color: "var(--text-tertiary, #6a6a74)", display: "none",
      }}>
        <Icon path={mdiDotsHorizontal} size={0.55} />
      </span>
      <style>{`[data-testid="machine-roster-card"]:hover .machine-roster-kebab { display: flex !important; }`}</style>
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
          style={{ ...base, background: "#e6a55a" }}
        />
      );
    case "offline":
    default:
      return (
        <span
          aria-hidden="true"
          data-testid="machine-roster-dot"
          style={{ ...base, background: "#6a6a72" }}
        />
      );
  }
}
