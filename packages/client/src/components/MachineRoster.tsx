/**
 * MachineRoster — permanent sidebar roster of configured agent hosts.
 *
 * Visual contract: mockup `mockups/walle-multi-machine/index.html` + design
 * spec §B.3. Key cues (Linear March-2026 + Tailscale admin + Docker rows):
 *   - 3px accent left-rail per row (operator's curated color)
 *   - 24px monogram tile with 2-letter abbreviation, accent bg, near-black fg
 *   - name + inline role; status line below ("● running · 4m ago")
 *   - right-aligned counts column (big n over "sessions" label)
 *   - running dot glows; idle dot is a hollow ring; offline is solid muted;
 *     never-connected is a dashed ring + dashed rail
 *   - offline/never rows sit at 55% opacity, hover lifts to 90%
 *
 * Status + accent colors are inlined as literal hex on purpose: they are
 * brand/semantic constants (theme-independent per spec §A.1) and the values
 * equal the `--s-*` / `--m-*` token ramp, so the roster reads identically
 * whether or not the token sheet is loaded — and stays jsdom-assertable.
 *
 * The per-machine inline "Ask" composer is GONE — starting work on a machine
 * is the explicit New Session flow (NewSessionPopover, §C), reached from the
 * session-list header button (target pre-set) or ⌘K.
 *
 * Renders nothing when `machines` is empty (framework default).
 *
 * See change: walle-multi-machine (Wave 1 — roster restyle).
 */
import { Icon } from "@mdi/react";
import { mdiPlus, mdiCogOutline } from "@mdi/js";
import type { MachineRosterEntry, MachineStatus } from "../hooks/useMachineRoster.js";

export interface MachineRosterProps {
  machines: MachineRosterEntry[];
  selectedMachineId?: string | null;
  onMachineSelect: (id: string | null) => void;
  /**
   * walle-multi-machine: compact horizontal-chip layout for mobile depth 0.
   * The stacked desktop rows eat a full phone screen before any session is
   * reachable; compact renders a single scrollable chip row, keeping the
   * session list above the fold.
   */
  compact?: boolean;
  /** Open the Add-Machine flow (roster header "+" and footer action). */
  onAddMachine?: () => void;
  /** Open the roster configuration (footer "Configure roster"). */
  onConfigureRoster?: () => void;
}

/** Derive a 2-letter abbreviation for the monogram tile. */
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

const SECTION_CAP: React.CSSProperties = {
  color: "var(--text-tertiary, #707078)",
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  fontWeight: 600,
};

export function MachineRoster({
  machines,
  selectedMachineId,
  onMachineSelect,
  compact = false,
  onAddMachine,
  onConfigureRoster,
}: MachineRosterProps) {
  if (machines.length === 0) return null;

  if (compact) {
    return (
      <div data-testid="machine-roster" style={{ borderBottom: "1px solid var(--border-secondary, rgba(255,255,255,0.075))" }}>
        <div
          style={{
            display: "flex",
            gap: 8,
            overflowX: "auto",
            padding: "10px 12px",
            WebkitOverflowScrolling: "touch",
            scrollbarWidth: "none",
          }}
        >
          {machines.map((m) => (
            <MachineChip
              key={m.id}
              machine={m}
              active={selectedMachineId === m.id}
              onClick={() => onMachineSelect(selectedMachineId === m.id ? null : m.id)}
            />
          ))}
        </div>
      </div>
    );
  }

  // Group by owner for multi-tenant separation.
  const grouped = groupByOwner(machines);

  return (
    <div data-testid="machine-roster" style={{ padding: "14px 12px 12px" }}>
      {/* Section header — "MACHINES" + add affordance */}
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          padding: "0 4px 8px",
          ...SECTION_CAP,
        }}
      >
        <span>Machines</span>
        {onAddMachine && (
        <button
          type="button"
          onClick={onAddMachine}
          data-testid="machine-roster-add"
          title="Add machine"
          aria-label="Add machine"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "none",
            border: "none",
            cursor: "pointer",
            padding: 0,
            color: "var(--text-tertiary, #707078)",
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-primary, #ececef)"; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-tertiary, #707078)"; }}
        >
          <Icon path={mdiPlus} size={0.62} />
        </button>
        )}
      </div>

      {/* Cards, potentially grouped by owner */}
      {grouped.map((group) => (
        <div key={group.owner ?? "__default"}>
          {group.owner && (
            <div
              style={{
                marginTop: 8,
                marginBottom: 4,
                padding: "6px 4px 4px",
                borderTop: "1px solid var(--border-subtle, rgba(255,255,255,0.045))",
                ...SECTION_CAP,
                fontWeight: 600,
              }}
            >
              {group.owner}
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {group.machines.map((m) => (
              <MachineRosterCard
                key={m.id}
                machine={m}
                active={selectedMachineId === m.id}
                onClick={() => onMachineSelect(selectedMachineId === m.id ? null : m.id)}
              />
            ))}
          </div>
        </div>
      ))}

      {/* Footer — add machine + configure roster */}
      <div
        style={{
          marginTop: 12,
          paddingTop: 8,
          borderTop: "1px solid var(--border-subtle, rgba(255,255,255,0.045))",
          display: "flex",
          flexDirection: "column",
          gap: 4,
        }}
      >
        {onAddMachine && (
        <RosterAction
          testid="machine-roster-footer-add"
          onClick={onAddMachine}
          leading={<span style={{ color: "var(--m-daemon, #5fb4a4)" }}>+</span>}
          label="Add machine…"
        />
        )}
        <RosterAction
          testid="machine-roster-footer-config"
          onClick={onConfigureRoster}
          leading={<Icon path={mdiCogOutline} size={0.6} />}
          label="Configure roster"
        />
      </div>
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

function RosterAction({
  testid,
  onClick,
  leading,
  label,
}: {
  testid: string;
  onClick?: () => void;
  leading: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testid}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 8px",
        borderRadius: 6,
        border: "none",
        background: "none",
        cursor: "pointer",
        textAlign: "left",
        width: "100%",
        fontFamily: "inherit",
        color: "var(--text-tertiary, #707078)",
        fontSize: 11,
      }}
      onMouseEnter={(e) => {
        const el = e.currentTarget as HTMLElement;
        el.style.background = "var(--bg-hover, rgba(255,255,255,0.03))";
        el.style.color = "var(--text-primary, #ececef)";
      }}
      onMouseLeave={(e) => {
        const el = e.currentTarget as HTMLElement;
        el.style.background = "none";
        el.style.color = "var(--text-tertiary, #707078)";
      }}
    >
      {leading}
      <span>{label}</span>
    </button>
  );
}

interface CardProps {
  machine: MachineRosterEntry;
  active: boolean;
  onClick: () => void;
}

function MachineRosterCard({ machine, active, onClick }: CardProps) {
  const status: MachineStatus = machine.status ?? "offline";
  // Never-connected: configured but no activity ever recorded. Renders dashed
  // (rail + dot) and "setup" copy, distinct from a once-live offline host.
  const never = status === "offline" && !machine.lastSeenAt && machine.sessionCount === 0;
  const dimmed = machine.sessionCount === 0 && status === "offline";
  // Literal hex (NOT a CSS var): the accent is the machine's identity color
  // and the default equals --m-never; keeping it literal makes it render and
  // assert without a resolved token sheet. See file header.
  const accent = machine.accent ?? "#4a4a52";
  const statusLabel = never ? "never connected" : (STATUS_LABELS[status] ?? "offline");
  const lastSeen = never ? "" : timeAgo(machine.lastSeenAt);

  const count = machine.sessionCount;
  const countN = count > 0 ? String(count) : never ? "·" : "—";
  const countLabel = count > 0 ? (count === 1 ? "session" : "sessions") : never ? "setup" : "—";

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
        display: "grid",
        gridTemplateColumns: "24px 1fr auto",
        alignItems: "center",
        gap: 10,
        padding: "10px 10px 10px 14px",
        borderRadius: "var(--r-card, 8px)",
        cursor: "pointer",
        border: "none",
        textAlign: "left",
        width: "100%",
        fontFamily: "inherit",
        transition: "background 120ms, opacity 150ms",
        background: active ? "rgba(255,255,255,0.04)" : "transparent",
        opacity: dimmed ? 0.55 : 1,
      }}
      onMouseEnter={(e) => {
        const el = e.currentTarget as HTMLElement;
        el.style.background = active ? "rgba(255,255,255,0.04)" : "rgba(255,255,255,0.025)";
        if (dimmed) el.style.opacity = "0.9";
      }}
      onMouseLeave={(e) => {
        const el = e.currentTarget as HTMLElement;
        el.style.background = active ? "rgba(255,255,255,0.04)" : "transparent";
        if (dimmed) el.style.opacity = "0.55";
      }}
    >
      {/* Accent left-rail (dashed for never-connected) */}
      <span
        aria-hidden="true"
        style={{
          position: "absolute",
          left: never ? -1 : 0,
          top: 6,
          bottom: 6,
          width: 3,
          borderRadius: 3,
          background: never ? "transparent" : accent,
          ...(never ? { borderLeft: "3px dashed #4a4a52" } : {}),
        }}
      />

      {/* Monogram tile */}
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
          fontFamily: "var(--f-mono, 'JetBrains Mono', ui-monospace, monospace)",
          letterSpacing: "-0.03em",
        }}
      >
        {abbrev(machine.label, machine.role)}
      </span>

      {/* Meta — name + role, then status line */}
      <span style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
        <span
          data-testid="machine-roster-label"
          style={{
            color: "var(--text-primary, #ececef)",
            fontSize: 13,
            fontWeight: 500,
            lineHeight: 1.3,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {machine.label}
          {machine.role && (
            <span style={{ color: "var(--text-tertiary, #707078)", fontWeight: 400, marginLeft: 4, fontSize: 11 }}>
              {machine.role}
            </span>
          )}
        </span>
        <span
          data-testid="machine-roster-sub"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
            color: "var(--text-tertiary, #707078)",
            fontSize: 11,
            lineHeight: 1.3,
          }}
        >
          <StatusDot status={status} never={never} />
          <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {statusLabel}
            {lastSeen ? ` · ${lastSeen}` : ""}
          </span>
        </span>
      </span>

      {/* Counts column */}
      <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
        <span
          data-testid="machine-roster-count"
          style={{
            color: "var(--text-primary, #ececef)",
            fontWeight: 500,
            fontSize: 12,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {countN}
        </span>
        <span style={{ color: "var(--text-tertiary, #707078)", fontSize: 10 }}>{countLabel}</span>
      </span>
    </button>
  );
}

/** Status dot with mockup-accurate subtlety (literal-hex brand constants). */
function StatusDot({ status, never = false }: { status: MachineStatus; never?: boolean }) {
  const base: React.CSSProperties = {
    width: 6,
    height: 6,
    borderRadius: "50%",
    flexShrink: 0,
  };

  if (never) {
    return (
      <span
        aria-hidden="true"
        data-testid="machine-roster-dot"
        style={{ ...base, background: "transparent", border: "1px dashed #2e2e35" }}
      />
    );
  }

  switch (status) {
    case "online":
      return (
        <span
          aria-hidden="true"
          data-testid="machine-roster-dot"
          style={{ ...base, background: "#5ed09a", boxShadow: "0 0 6px rgba(94,208,154,0.35)" }}
        />
      );
    case "idle":
      return (
        <span
          aria-hidden="true"
          data-testid="machine-roster-dot"
          style={{ ...base, background: "transparent", border: "1px solid #b9b9c0" }}
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

/**
 * walle-multi-machine: compact machine chip for the mobile horizontal strip.
 * Accent-tinted when active; status dot + label + alive-session count. Tap
 * toggles selection (filters the session list to this machine).
 */
function MachineChip({
  machine,
  active,
  onClick,
}: {
  machine: MachineRosterEntry;
  active: boolean;
  onClick: () => void;
}) {
  const accent = machine.accent || "#5b6470";
  return (
    <button
      onClick={onClick}
      title={`${machine.label} · ${STATUS_LABELS[machine.status]}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        flexShrink: 0,
        padding: "7px 12px",
        borderRadius: 9,
        whiteSpace: "nowrap",
        cursor: "pointer",
        border: active ? `1px solid ${accent}66` : "1px solid var(--border-secondary, rgba(255,255,255,0.08))",
        background: active ? `${accent}1f` : "var(--bg-hover, rgba(255,255,255,0.025))",
        color: "var(--text-primary, #ececef)",
        fontSize: 12.5,
        lineHeight: 1,
      }}
    >
      <StatusDot status={machine.status} />
      <span style={{ fontWeight: 600 }}>{machine.label}</span>
      {machine.sessionCount > 0 && (
        <span style={{ fontSize: 11, color: "var(--text-tertiary, #707078)" }}>
          {machine.sessionCount}
        </span>
      )}
    </button>
  );
}
