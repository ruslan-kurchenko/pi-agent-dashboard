/**
 * MobileActionBar — the mobile bottom action bar (56px, `--bg-nav`).
 *
 * Three thumb-first items: Machines / Start (accent, center hero) /
 * Continue. Supersedes the bare circular CommandPalette FAB. Hidden
 * when a session detail is open (depth 1) so it never overlaps the
 * composer. Start opens the NewSessionPopover as a bottom-sheet;
 * Continue opens `ResumeRecentSheet` (recent ended sessions, machine-
 * aware Resume rows). See design-spec §E.2.
 *
 * All hit targets are ≥44×44 and the bar respects the bottom safe
 * area. Owned by ClientShell. See change: dashboard-sota-multi-machine.
 */
import React from "react";
import { DialogPortal } from "./DialogPortal.js";

export type MobileActionView = "machines" | "list" | "start" | "continue" | null;

export interface MobileActionBarProps {
  /** Accent fill for the Start (hero) tile — target machine accent. */
  targetAccent?: string;
  /** Which view is active, for the active-item highlight. */
  activeView?: MobileActionView;
  /** Hidden when a session detail is open (depth 1). */
  hidden?: boolean;
  onMachines: () => void;
  onStart: () => void;
  onContinue: () => void;
}

const ITEM_BASE =
  "flex flex-col items-center justify-center gap-0.5 text-[10px] min-w-[44px] min-h-[44px] cursor-pointer";
const TILE_BASE = "flex h-8 w-8 items-center justify-center rounded-lg transition-colors";

export function MobileActionBar({
  targetAccent,
  activeView,
  hidden,
  onMachines,
  onStart,
  onContinue,
}: MobileActionBarProps) {
  if (hidden) return null;

  const machinesActive = activeView === "machines";
  return (
    <div
      className="fixed inset-x-0 bottom-0 z-40 flex items-center justify-around bg-[var(--bg-nav)] border-t border-[var(--border-secondary)] px-3"
      style={{
        height: "calc(56px + env(safe-area-inset-bottom))",
        paddingBottom: "env(safe-area-inset-bottom)",
      }}
      data-testid="mobile-action-bar"
    >
      <button
        type="button"
        onClick={onMachines}
        className={`${ITEM_BASE} ${machinesActive ? "text-[var(--text-primary)]" : "text-[var(--text-tertiary)]"}`}
        data-testid="mobile-action-machines"
      >
        <span
          className={`${TILE_BASE} ${machinesActive ? "bg-[var(--bg-surface)] text-[var(--text-primary)]" : "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"}`}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <rect x="1.5" y="1.5" width="5" height="5" rx="1" />
            <rect x="9.5" y="1.5" width="5" height="5" rx="1" />
            <rect x="1.5" y="9.5" width="5" height="5" rx="1" />
            <rect x="9.5" y="9.5" width="5" height="5" rx="1" />
          </svg>
        </span>
        Machines
      </button>

      <button
        type="button"
        onClick={onStart}
        className={`${ITEM_BASE} text-[var(--text-secondary)]`}
        data-testid="mobile-action-start"
      >
        <span className={`${TILE_BASE} text-[#15151a]`} style={{ background: targetAccent ?? "var(--m-daemon)" }}>
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M8 2.5v11M2.5 8h11" />
          </svg>
        </span>
        Start
      </button>

      <button
        type="button"
        onClick={onContinue}
        className={`${ITEM_BASE} text-[var(--text-tertiary)]`}
        data-testid="mobile-action-continue"
      >
        <span className={`${TILE_BASE} bg-[var(--bg-tertiary)] text-[var(--text-secondary)]`}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <path d="M2.5 8a5.5 5.5 0 105.5-5.5" />
            <path d="M8 2.5L5 0.5M8 2.5L5 4.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        Continue
      </button>
    </div>
  );
}

export interface ResumeRecentItem {
  id: string;
  title: string;
  /** "{machine} · {state} · {age}" meta line. */
  sub: string;
  /** Machine accent for the row glyph. */
  accent?: string;
}

export interface ResumeRecentSheetProps {
  open: boolean;
  items: ResumeRecentItem[];
  onResume: (sessionId: string) => void;
  onClose: () => void;
}

/**
 * Continue sheet — a mobile bottom-sheet listing recent ended sessions.
 * Mirrors the ⌘K palette's "Continue recent"; tapping a row resumes it.
 */
export function ResumeRecentSheet({ open, items, onResume, onClose }: ResumeRecentSheetProps) {
  if (!open) return null;
  return (
    <DialogPortal>
      <div
        className="fixed inset-0 z-50 flex items-end justify-center bg-[var(--bg-overlay)] backdrop-blur-[4px]"
        onClick={onClose}
        data-testid="resume-recent-backdrop"
      >
        <div
          role="dialog"
          aria-label="Continue a recent session"
          onClick={(e) => e.stopPropagation()}
          className="w-full max-h-[70vh] overflow-y-auto rounded-t-xl bg-[var(--bg-secondary)] border-t border-[var(--border-primary)] shadow-[0_-8px_32px_rgba(0,0,0,0.5)]"
          style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
          data-testid="resume-recent-sheet"
        >
          <div className="px-4 pt-3 pb-2 text-[10px] uppercase tracking-[0.08em] font-semibold text-[var(--text-tertiary)]">
            Continue recent
          </div>
          {items.length === 0 ? (
            <div className="px-4 py-6 text-[12px] text-[var(--text-tertiary)]">
              No recent ended sessions to resume.
            </div>
          ) : (
            <div className="pb-2">
              {items.map((it) => (
                <button
                  key={it.id}
                  type="button"
                  onClick={() => {
                    onResume(it.id);
                    onClose();
                  }}
                  className="grid w-full grid-cols-[22px_1fr] items-center gap-3 px-4 py-2.5 text-left min-h-[44px] hover:bg-[var(--bg-hover)]"
                  data-testid="resume-recent-row"
                >
                  <span
                    aria-hidden="true"
                    className="flex h-[22px] w-[22px] items-center justify-center rounded-[5px] text-[11px] font-bold text-[#15151a]"
                    style={{ background: it.accent ?? "var(--m-never)" }}
                  >
                    ω
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] text-[var(--text-primary)]">{it.title}</span>
                    <span className="block truncate text-[11px] text-[var(--text-tertiary)]">{it.sub}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </DialogPortal>
  );
}
