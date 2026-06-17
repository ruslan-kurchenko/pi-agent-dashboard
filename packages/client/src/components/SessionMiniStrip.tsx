/**
 * SessionMiniStrip — compact vertical strip of session status dots shown
 * when the session sidebar is collapsed. Each dot represents one session;
 * color encodes status (green=alive, amber=streaming, purple=input,
 * gray=ended). Hover shows the session name as a tooltip.
 *
 * See change: walle-multi-machine (collapsible columns).
 */
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";

interface Props {
  sessions: DashboardSession[];
  selectedId?: string | null;
  onSelect: (id: string) => void;
}

function statusColor(session: DashboardSession): string {
  const s = session.status;
  if (s === "ended") return "#44444c";
  if (s === "streaming" || s === "working") return "#e2b340";
  if (s === "waiting_for_input") return "#b490e0";
  return "#4ade80"; // alive / default
}

export function SessionMiniStrip({ sessions, selectedId, onSelect }: Props) {
  if (sessions.length === 0) return null;

  // Sort: alive first, then by start time desc
  const sorted = [...sessions].sort((a, b) => {
    const aAlive = a.status !== "ended" ? 1 : 0;
    const bAlive = b.status !== "ended" ? 1 : 0;
    if (aAlive !== bAlive) return bAlive - aAlive;
    // walle-multi-machine: startedAt is a number (epoch ms) — numeric sort, NOT
    // localeCompare (which is string-only and throws "is not a function" on a
    // number, crashing the shell ErrorBoundary). Matches every other startedAt sort.
    return (b.startedAt ?? 0) - (a.startedAt ?? 0);
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, padding: "0 4px" }}>
      {sorted.slice(0, 30).map((s) => {
        const color = statusColor(s);
        const isSelected = s.id === selectedId;
        const name = s.name || s.cwd?.split("/").pop() || s.id.slice(0, 8);
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => onSelect(s.id)}
            title={name}
            style={{
              width: isSelected ? 24 : 8,
              height: 8,
              borderRadius: 4,
              background: color,
              border: "none",
              cursor: "pointer",
              transition: "width 150ms, opacity 150ms",
              opacity: isSelected ? 1 : 0.6,
              flexShrink: 0,
            }}
          />
        );
      })}
      {sessions.length > 30 && (
        <span style={{ fontSize: 9, color: "var(--text-muted)", marginTop: 2 }}>
          +{sessions.length - 30}
        </span>
      )}
    </div>
  );
}
