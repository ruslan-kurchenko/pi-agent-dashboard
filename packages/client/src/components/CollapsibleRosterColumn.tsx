/**
 * CollapsibleRosterColumn — the leftmost column housing the machine roster.
 *
 * Expanded (220 px): full MachineRoster with labels, status lines, counts.
 * Collapsed (48 px): just the accent icon squares stacked vertically, plus
 * a tooltip on hover showing the label + status.
 *
 * Collapse state is persisted to localStorage via useCollapsibleColumn.
 * Double-click the collapse handle to toggle (same pattern as the session
 * sidebar's chevron button).
 *
 * See change: walle-multi-machine (collapsible columns).
 */
import { Icon } from "@mdi/react";
import { mdiChevronLeft, mdiChevronRight } from "@mdi/js";
import { MachineRoster, type MachineRosterProps } from "./MachineRoster.js";
import type { CollapsibleColumnState } from "../hooks/useCollapsibleColumn.js";
import type { MachineStatus } from "../hooks/useMachineRoster.js";

const EXPANDED_WIDTH = 220;
const COLLAPSED_WIDTH = 52;

interface Props extends MachineRosterProps {
  column: CollapsibleColumnState;
}

/** 2-letter abbreviation for the icon square. */
function abbrev(label: string, role?: string): string {
  if (role === "daemon") return "wd";
  const words = label.replace(/[()[\]]/g, "").trim().split(/\s+/);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toLowerCase();
  return label.slice(0, 2).toLowerCase();
}

function dotColor(status?: MachineStatus): string {
  switch (status) {
    case "online": return "#4ade80";
    case "idle": return "#a0a0a8";
    case "unreachable": return "#e8944a";
    default: return "#44444c";
  }
}

export function CollapsibleRosterColumn({
  column,
  machines,
  selectedMachineId,
  onMachineSelect,
}: Props) {
  if (machines.length === 0) return null;

  // ── Collapsed: icon strip ──
  if (column.collapsed) {
    return (
      <div
        className="hidden md:flex flex-col flex-shrink-0 border-r relative"
        style={{
          width: COLLAPSED_WIDTH,
          background: "var(--bg-secondary)",
          borderColor: "var(--border-primary)",
        }}
        data-testid="roster-column-collapsed"
      >
        {/* Mini icon squares */}
        <div style={{ padding: "14px 0 8px", display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
          {machines.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => onMachineSelect(selectedMachineId === m.id ? null : m.id)}
              title={`${m.label} — ${m.status ?? "offline"}`}
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                background: m.accent ?? "#26262b",
                color: "#0e0e10",
                fontSize: 11,
                fontWeight: 700,
                fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                textTransform: "uppercase",
                letterSpacing: "-0.03em",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                border: "none",
                cursor: "pointer",
                position: "relative",
                opacity: m.sessionCount === 0 && m.status === "offline" ? 0.5 : 0.85,
                transition: "opacity 120ms",
                ...(selectedMachineId === m.id
                  ? { boxShadow: `0 0 0 2px ${m.accent ?? "#5b9bd5"}60` }
                  : {}),
              }}
            >
              {abbrev(m.label, m.role)}
              {/* Status dot — bottom-right corner */}
              <span
                style={{
                  position: "absolute",
                  bottom: -1,
                  right: -1,
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: dotColor(m.status),
                  border: "2px solid var(--bg-secondary)",
                  ...(m.status === "online"
                    ? { boxShadow: `0 0 4px ${dotColor("online")}60` }
                    : {}),
                }}
              />
            </button>
          ))}
        </div>

        {/* Expand chevron */}
        <button
          onClick={column.toggle}
          className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-1/2 z-10 w-5 h-8 flex items-center justify-center rounded-full bg-[var(--bg-tertiary)] border border-[var(--border-secondary)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface)] shadow-md transition-colors cursor-pointer"
          title="Expand machines"
          data-testid="roster-expand"
        >
          <Icon path={mdiChevronRight} size={0.55} />
        </button>
      </div>
    );
  }

  // ── Expanded: full roster ──
  return (
    <div
      className="hidden md:flex flex-col flex-shrink-0 border-r relative"
      style={{
        width: EXPANDED_WIDTH,
        background: "var(--bg-secondary)",
        borderColor: "var(--border-primary)",
      }}
      data-testid="roster-column-expanded"
    >
      <MachineRoster
        machines={machines}
        selectedMachineId={selectedMachineId}
        onMachineSelect={onMachineSelect}
      />

      {/* Collapse chevron */}
      <button
        onClick={column.toggle}
        className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-1/2 z-10 w-5 h-8 flex items-center justify-center rounded-full bg-[var(--bg-tertiary)] border border-[var(--border-secondary)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface)] shadow-md transition-colors cursor-pointer"
        title="Collapse machines"
        data-testid="roster-collapse"
      >
        <Icon path={mdiChevronLeft} size={0.55} />
      </button>
    </div>
  );
}
