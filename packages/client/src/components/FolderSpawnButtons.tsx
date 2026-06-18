/**
 * Elevated spawn-button stack for folder groups in the sidebar.
 *
 * Renders two full-width stacked line buttons in the always-visible folder
 * header (below the trimmed FolderActionBar, above the plugin/OpenSpec
 * sections):
 *   - `+ New Session` (green) — always rendered.
 *   - `+ New Worktree` (orange) — rendered only when `showWorktree` holds.
 *
 * See change: elevate-folder-spawn-buttons.
 */
import { Icon } from "@mdi/react";
import { mdiPlus, mdiSourceBranchPlus } from "@mdi/js";

interface Props {
  /** Disables `+ New Session` while a session is being spawned in this folder. */
  spawningDisabled?: boolean;
  /**
   * Whether to render `+ New Worktree`. Caller computes
   * `isGitRepo && gitWorktreeEnabled && !!onSpawnWorktree`.
   */
  showWorktree: boolean;
  onSpawnSession: () => void;
  onSpawnWorktree?: () => void;
  /** Monitor-only mode: hides all spawn affordances. */
  spawnDisabled?: boolean;
  /**
   * walle-multi-machine: suppress the per-folder `+ New Session` button when
   * the unified New Session flow (NewSessionPopover, opened from the session-
   * list header) is the sanctioned spawn entry. The `+ New Worktree` button
   * (a distinct affordance) is unaffected. See design §C / §F.
   */
  hideNewSession?: boolean;
}

export function FolderSpawnButtons({
  spawningDisabled,
  showWorktree,
  onSpawnSession,
  onSpawnWorktree,
  spawnDisabled,
  hideNewSession,
}: Props) {
  if (spawnDisabled) return null;
  if (hideNewSession && !showWorktree) return null;
  return (
    <div className="flex flex-col gap-1">
      {!hideNewSession && (
        <button
          onClick={(e) => { e.stopPropagation(); onSpawnSession(); }}
          disabled={spawningDisabled}
          data-testid="folder-spawn-session-btn"
          className={`w-full text-xs px-2 py-1 rounded border flex items-center justify-center gap-0.5 ${
            spawningDisabled
              ? "border-[var(--border-secondary)] text-[var(--text-secondary)] opacity-50 cursor-not-allowed"
              : "text-green-400 border-green-500/40 bg-green-500/5 hover:text-green-300 hover:border-green-500/70"
          }`}
          title="New pi session"
        >
          <Icon path={mdiPlus} size={0.6} /> New Session
        </button>
      )}

      {showWorktree && (
        <button
          onClick={(e) => { e.stopPropagation(); onSpawnWorktree!(); }}
          data-testid="folder-spawn-worktree-btn"
          className="w-full text-xs px-2 py-1 rounded border flex items-center justify-center gap-0.5 text-orange-400 border-orange-500/40 bg-orange-500/5 hover:text-orange-300 hover:border-orange-500/70"
          title="New pi session in a git worktree"
        >
          <Icon path={mdiSourceBranchPlus} size={0.6} /> New Worktree
        </button>
      )}
    </div>
  );
}
