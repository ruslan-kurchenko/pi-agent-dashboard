/**
 * NewSessionPopover — the SOTA "New Session" flow (design spec §C.2–C.4).
 *
 * Starting a new agent run is a FIRST-CLASS, explicit action — never the
 * chat composer (which only continues an already-open session). This popover
 * is opened from the session-list header "+ New session" button (target
 * pre-set to the selected roster machine) and from the mobile bottom action
 * bar "Start". The ⌘K CommandPalette is its keyboard-first twin.
 *
 * Three progressive, pre-filled steps so the common path is one-or-two
 * interactions:
 *   1. target machine  — roster rows; offline machines dimmed + non-selectable.
 *   2. working directory — recent dirs + pinned dirs + free text. Device-aware
 *      copy (daemon: "/workspace/agent · pick cwd"; laptop: "choose folder").
 *   3. optional first prompt + device-aware Start. Daemon requires a first
 *      prompt (autonomous home-agent spawn needs one); laptop's prompt is
 *      optional (passed through as omp positional MESSAGES).
 *
 * Desktop = compact popover (centered, like the palette); mobile = bottom
 * sheet. Focus-trap + snapshot/restore focus mirrors CommandPalette.
 *
 * Wiring contract: this component is PURE UI. It never calls the server. The
 * host (ClientShell/App) owns `open`, `onStart` (→ device-aware
 * `handleStartNewSession`) and `onClose`. See local://walle-dash-wiring-contract.md.
 *
 * Steps are implemented locally (self-contained, no cross-file coupling with
 * the ClientShell-owned CommandPalette) so the two flows can stay independent
 * while producing identical results for the same target + cwd + prompt.
 *
 * See change: walle-multi-machine (Wave 1 — New Session flow).
 */
import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { DialogPortal } from "./DialogPortal.js";
import { useMobile } from "../hooks/useMobile.js";
import type { MachineRosterEntry, MachineStatus } from "../hooks/useMachineRoster.js";

/**
 * FIXED prop contract with ClientShell (see wiring contract §"Prop contract").
 * ClientShell owns `open`/`onStart`/`onClose`; this component builds the UI.
 */
export interface NewSessionPopoverProps {
  open: boolean;
  /** Roster of configured machines — pass `useMachineRoster().machines`. */
  machines: MachineRosterEntry[];
  /** Pre-selected target (the selected roster machine, else "this device"). */
  defaultMachineId?: string;
  /** Recent cwds for a machine id (host derives from its sessions Map). */
  recentCwds: (machineId: string) => string[];
  /** Operator-pinned directories, shown above the free-text input. */
  pinnedDirectories?: string[];
  /** Submit. Host turns this into the device-aware spawn/message route. */
  onStart: (args: { machineId: string; cwd?: string; prompt?: string }) => void;
  /** Esc from step 1, backdrop click, or successful submit. */
  onClose: () => void;
}

type Step = "machine" | "cwd" | "prompt";

/** Status dot color vocabulary — same `--s-*` tokens as MachineRoster/palette. */
const STATUS_DOT: Record<MachineStatus, string> = {
  online: "var(--s-running, #5ed09a)",
  idle: "var(--s-idle, #b9b9c0)",
  offline: "var(--s-offline, #6a6a72)",
  unreachable: "var(--s-unreach, #e6a55a)",
};

const STATUS_LABEL: Record<MachineStatus, string> = {
  online: "online",
  idle: "idle",
  offline: "offline",
  unreachable: "unreachable",
};

/**
 * Daemon = the dashboard's own wall-e host (message route → /inject). Anything
 * else (laptop/remote) is spawn-omp. See wiring contract §"Device-awareness".
 */
function isDaemonTarget(m: MachineRosterEntry | undefined): boolean {
  return !!m && (m.role === "daemon" || m.messageable === true);
}

/**
 * Offline machines are listed but not selectable as a target (§C.4). A
 * messageable host is always reachable, so it is never "offline" here.
 */
function isOfflineTarget(m: MachineRosterEntry | undefined): boolean {
  if (!m) return true;
  if (m.messageable === true) return false;
  return m.status === "offline" || m.status === "unreachable";
}

export function NewSessionPopover({
  open,
  machines,
  defaultMachineId,
  recentCwds,
  pinnedDirectories,
  onStart,
  onClose,
}: NewSessionPopoverProps) {
  const mobile = useMobile();

  const [step, setStep] = useState<Step>("machine");
  const [machineIdx, setMachineIdx] = useState(0);
  const [cwd, setCwd] = useState("");
  const [prompt, setPrompt] = useState("");

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const cwdInputRef = useRef<HTMLInputElement | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  // Default target: the supplied `defaultMachineId` when it is selectable,
  // else the first selectable machine, else index 0 (everything offline →
  // Start stays disabled). Mirrors §C.4's "default to first online" rule.
  const defaultIdx = useMemo(() => {
    if (defaultMachineId) {
      const i = machines.findIndex((m) => m.id === defaultMachineId);
      if (i >= 0 && !isOfflineTarget(machines[i])) return i;
    }
    const j = machines.findIndex((m) => !isOfflineTarget(m));
    return j >= 0 ? j : 0;
  }, [machines, defaultMachineId]);

  const selectedMachine = machines[machineIdx];
  const daemon = isDaemonTarget(selectedMachine);
  const label = selectedMachine?.label ?? "?";
  const accent = selectedMachine?.accent ?? "var(--m-never, #4a4a52)";

  // Reset the flow on every open: step 1, default target, recent[0] cwd.
  useEffect(() => {
    if (!open) return;
    setStep("machine");
    setMachineIdx(defaultIdx);
    const m = machines[defaultIdx];
    const recent = m ? recentCwds(m.id) : [];
    setCwd(recent[0] ?? "");
    setPrompt("");
  }, [open, defaultIdx, machines, recentCwds]);

  // Snapshot the active element on open, restore on close.
  useEffect(() => {
    if (!open) {
      previousFocusRef.current?.focus?.();
      previousFocusRef.current = null;
      return;
    }
    previousFocusRef.current = document.activeElement as HTMLElement | null;
  }, [open]);

  // Per-step initial focus.
  useEffect(() => {
    if (!open) return;
    if (step === "cwd") {
      const el = cwdInputRef.current;
      el?.focus();
      if (el) {
        const len = el.value.length;
        try { el.setSelectionRange(len, len); } catch { /* ignore */ }
      }
      return;
    }
    if (step === "prompt") {
      promptRef.current?.focus();
      return;
    }
    dialogRef.current?.focus();
  }, [open, step]);

  // Trap Tab inside the dialog (same minimal wrap as CommandPalette).
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Tab") return;
      const root = dialogRef.current;
      if (!root) return;
      const focusables = Array.from(
        root.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute("disabled") && el.offsetParent !== null);
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // Recent + pinned cwd suggestions for the chosen machine, filtered by the
  // current input. Pinned dirs surface first (deduped against recents).
  const suggestions = useMemo(() => {
    if (!selectedMachine) return [] as { path: string; pinned: boolean }[];
    const q = cwd.trim().toLowerCase();
    const recent = recentCwds(selectedMachine.id);
    const pinned = pinnedDirectories ?? [];
    const seen = new Set<string>();
    const out: { path: string; pinned: boolean }[] = [];
    for (const p of pinned) {
      if (seen.has(p)) continue;
      seen.add(p);
      out.push({ path: p, pinned: true });
    }
    for (const p of recent) {
      if (seen.has(p)) continue;
      seen.add(p);
      out.push({ path: p, pinned: false });
    }
    const filtered = q ? out.filter((s) => s.path.toLowerCase().includes(q)) : out;
    return filtered.slice(0, 8);
  }, [selectedMachine, cwd, recentCwds, pinnedDirectories]);

  // Daemon needs a first prompt; laptop/remote needs a cwd. Either way a
  // selectable target is required.
  const cwdValue = cwd.trim();
  const promptValue = prompt.trim();
  const targetOk = !!selectedMachine && !isOfflineTarget(selectedMachine);
  const canStart = targetOk && (daemon ? promptValue.length > 0 : cwdValue.length > 0);

  const submit = useCallback(() => {
    if (!selectedMachine) return;
    if (isOfflineTarget(selectedMachine)) return;
    const c = cwd.trim();
    const p = prompt.trim();
    if (isDaemonTarget(selectedMachine)) {
      if (!p) return; // daemon spawn requires a first prompt
    } else if (!c) {
      return; // laptop/remote spawn requires a cwd
    }
    onStart({
      machineId: selectedMachine.id,
      cwd: c || undefined,
      prompt: p || undefined,
    });
    onClose();
  }, [selectedMachine, cwd, prompt, onStart, onClose]);

  // Advance from the machine step to cwd, pre-filling cwd from the picked
  // machine's most-recent dir.
  const selectMachine = useCallback(
    (idx: number) => {
      const m = machines[idx];
      if (!m || isOfflineTarget(m)) return;
      setMachineIdx(idx);
      const recent = recentCwds(m.id);
      setCwd(recent[0] ?? "");
      setStep("cwd");
    },
    [machines, recentCwds],
  );

  // Esc / Arrow / Enter on the dialog container. Keydowns bubble from inputs.
  const handleDialogKey = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (step === "machine") onClose();
        else if (step === "cwd") setStep("machine");
        else setStep("cwd");
        return;
      }
      if (step === "machine") {
        if (machines.length === 0) return;
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setMachineIdx((i) => (i + 1) % machines.length);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          setMachineIdx((i) => (i - 1 + machines.length) % machines.length);
        } else if (e.key === "Enter") {
          e.preventDefault();
          selectMachine(machineIdx);
        }
        return;
      }
      if (step === "cwd") {
        if (e.key === "Enter") {
          e.preventDefault();
          // Laptop requires a cwd to advance; daemon may skip it.
          if (daemon || cwd.trim()) setStep("prompt");
        }
        return;
      }
      // step === "prompt": ⌘↵ / Ctrl↵ submits (plain Enter = newline, handled
      // on the textarea via stopPropagation).
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submit();
      }
    },
    [step, machines, machineIdx, cwd, daemon, onClose, selectMachine, submit],
  );

  if (!open) return null;

  const stepNum = step === "machine" ? 1 : step === "cwd" ? 2 : 3;

  return (
    <DialogPortal>
      <div
        data-testid="new-session-backdrop"
        className={`fixed inset-0 z-50 bg-[var(--bg-overlay,rgba(0,0,0,0.55))] backdrop-blur-sm flex ${
          mobile ? "items-end justify-center" : "items-start justify-center pt-20"
        }`}
        onClick={onClose}
      >
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="new-session-title"
          data-testid="new-session-popover"
          data-step={step}
          tabIndex={-1}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={handleDialogKey}
          className={`outline-none bg-[var(--bg-secondary,#16161a)] border border-[var(--border-primary,rgba(255,255,255,0.13))] shadow-[0_24px_60px_rgba(0,0,0,0.6)] flex flex-col ${
            mobile
              ? "w-full max-h-[85vh] rounded-t-[12px]"
              : "w-[360px] max-w-[92vw] rounded-[var(--r-card,8px)] overflow-hidden"
          }`}
        >
          {/* Header */}
          <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--border-secondary,rgba(255,255,255,0.075))]">
            {step !== "machine" ? (
              <button
                type="button"
                onClick={() => setStep(step === "cwd" ? "machine" : "cwd")}
                aria-label="Back"
                data-testid="new-session-back"
                className="flex h-6 w-6 items-center justify-center rounded text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
              >
                ‹
              </button>
            ) : null}
            <h2
              id="new-session-title"
              className="flex-1 text-[13px] font-medium text-[var(--text-primary)]"
            >
              New session
            </h2>
            <span
              aria-hidden="true"
              className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-tertiary)]"
            >
              Step {stepNum} of 3
            </span>
          </div>

          {/* Body */}
          {machines.length === 0 ? (
            <EmptyRoster />
          ) : step === "machine" ? (
            <MachineStep
              machines={machines}
              activeIdx={machineIdx}
              onHover={setMachineIdx}
              onSelect={selectMachine}
            />
          ) : step === "cwd" ? (
            <CwdStep
              daemon={daemon}
              label={label}
              inputRef={cwdInputRef}
              value={cwd}
              onChange={setCwd}
              suggestions={suggestions}
              onPickSuggestion={(s) => {
                setCwd(s);
                setStep("prompt");
              }}
            />
          ) : (
            <PromptStep
              daemon={daemon}
              label={label}
              accent={accent}
              host={selectedMachine?.host}
              cwd={cwdValue}
              promptRef={promptRef}
              value={prompt}
              onChange={setPrompt}
              canStart={canStart}
              onStart={submit}
            />
          )}

          {/* Footer kbd hints */}
          <div className="flex gap-4 px-4 py-2 border-t border-[var(--border-secondary,rgba(255,255,255,0.075))] text-[10px] text-[var(--text-tertiary)]">
            {step === "machine" ? (
              <>
                <span><kbd className="font-mono">↑↓</kbd> navigate</span>
                <span><kbd className="font-mono">↵</kbd> select</span>
                <span><kbd className="font-mono">esc</kbd> close</span>
              </>
            ) : step === "cwd" ? (
              <>
                <span><kbd className="font-mono">↵</kbd> next</span>
                <span><kbd className="font-mono">esc</kbd> back</span>
              </>
            ) : (
              <>
                <span><kbd className="font-mono">⌘↵</kbd> start</span>
                <span><kbd className="font-mono">esc</kbd> back</span>
              </>
            )}
          </div>
        </div>
      </div>
    </DialogPortal>
  );
}

// ── Subcomponents ────────────────────────────────────────────────

function EmptyRoster() {
  return (
    <div className="flex flex-col gap-3 px-4 py-6">
      <div className="text-[13px] text-[var(--text-primary)]">No machines configured</div>
      <div className="text-[11px] text-[var(--text-tertiary)]">
        Add a machine from the roster to start a session.
      </div>
      <div
        data-testid="new-session-add-machine"
        className="self-start text-[11px] text-[var(--text-tertiary)]"
      >
        <span style={{ color: "var(--m-daemon, #5fb4a4)" }}>+</span> Add machine…
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: MachineStatus }) {
  const base = "inline-block h-[6px] w-[6px] rounded-full shrink-0";
  if (status === "online") {
    return (
      <span
        aria-hidden="true"
        className={base}
        style={{
          background: STATUS_DOT.online,
          boxShadow: "0 0 6px rgba(94,208,154,0.35)",
        }}
      />
    );
  }
  if (status === "idle") {
    return (
      <span
        aria-hidden="true"
        className={base}
        style={{ background: "transparent", border: `1px solid ${STATUS_DOT.idle}` }}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={base}
      style={{ background: STATUS_DOT[status] }}
    />
  );
}

function MachineStep({
  machines,
  activeIdx,
  onHover,
  onSelect,
}: {
  machines: MachineRosterEntry[];
  activeIdx: number;
  onHover: (idx: number) => void;
  onSelect: (idx: number) => void;
}) {
  return (
    <div role="listbox" aria-label="Target machine" className="py-2 max-h-[60vh] overflow-y-auto">
      {machines.map((m, i) => {
        const active = i === activeIdx;
        const status = m.status ?? "offline";
        const accent = m.accent ?? "var(--m-never, #4a4a52)";
        const offline = isOfflineTarget(m);
        const daemon = isDaemonTarget(m);
        const roleText = daemon ? "daemon" : m.role || (m.messageable ? "this device" : "remote");
        return (
          <div key={m.id}>
            <button
              type="button"
              role="option"
              aria-selected={active}
              aria-disabled={offline}
              data-testid="new-session-machine"
              data-machine-id={m.id}
              data-active={active ? "true" : "false"}
              data-offline={offline ? "true" : "false"}
              onClick={() => onSelect(i)}
              onMouseEnter={() => onHover(i)}
              className={`w-full grid grid-cols-[24px_1fr_auto] items-center gap-[10px] px-4 py-[7px] text-left text-[13px] ${
                offline ? "opacity-55 cursor-not-allowed" : ""
              } ${
                active
                  ? "bg-[var(--bg-hover,rgba(255,255,255,0.04))] text-[var(--text-primary)]"
                  : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover,rgba(255,255,255,0.03))]"
              }`}
            >
              {/* Monogram tile (accent fill, near-black fg) */}
              <span
                aria-hidden="true"
                className="flex h-[24px] w-[24px] items-center justify-center rounded-[6px] font-mono text-[11px] font-bold"
                style={{ backgroundColor: accent, color: "#15151a", opacity: 0.85 }}
              >
                {abbrev(m.label, m.role)}
              </span>
              <span className="min-w-0">
                <span className="block truncate font-medium">
                  {m.label}
                  <span className="ml-1 text-[11px] font-normal text-[var(--text-tertiary)]">{roleText}</span>
                </span>
                <span className="block truncate text-[11px] text-[var(--text-tertiary)]">{m.id}</span>
              </span>
              <span className="flex items-center gap-2 text-[11px] text-[var(--text-tertiary)]">
                <StatusDot status={status} />
                <span>{STATUS_LABEL[status]}</span>
              </span>
            </button>
            {offline ? (
              <div className="px-4 pb-1 text-[10px] text-[var(--text-muted)]">{m.label} is offline</div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function CwdStep({
  daemon,
  label,
  inputRef,
  value,
  onChange,
  suggestions,
  onPickSuggestion,
}: {
  daemon: boolean;
  label: string;
  inputRef: React.MutableRefObject<HTMLInputElement | null>;
  value: string;
  onChange: (v: string) => void;
  suggestions: { path: string; pinned: boolean }[];
  onPickSuggestion: (s: string) => void;
}) {
  return (
    <div className="flex flex-col">
      <div className="px-4 pt-3 pb-2 text-[11px] text-[var(--text-tertiary)]">
        {daemon ? (
          <>
            <span className="font-mono text-[var(--text-secondary)]">/workspace/agent</span> · pick cwd
          </>
        ) : (
          <>
            <span className="font-mono text-[var(--text-secondary)]">~/Projects/*</span> · choose folder on{" "}
            <span className="font-medium text-[var(--text-secondary)]">{label}</span>
          </>
        )}
      </div>
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={daemon ? "/workspace/agent (optional)" : "/path/to/project"}
        aria-label="Working directory"
        data-testid="new-session-cwd-input"
        className="mx-4 mb-2 rounded-[6px] border border-[var(--border-secondary,rgba(255,255,255,0.075))] bg-[var(--bg-tertiary,#1c1c21)] px-3 py-2 font-mono text-[12.5px] text-[var(--text-primary)] outline-none focus:border-[var(--accent-blue,#5fb4a4)]"
      />
      {suggestions.length > 0 ? (
        <div
          role="listbox"
          aria-label="Recent and pinned directories"
          data-testid="new-session-suggestions"
          className="border-t border-[var(--border-subtle,rgba(255,255,255,0.045))] py-1 max-h-[40vh] overflow-y-auto"
        >
          {suggestions.map((s) => (
            <button
              key={s.path}
              type="button"
              role="option"
              aria-selected={false}
              data-testid="new-session-suggestion"
              onClick={() => onPickSuggestion(s.path)}
              className="flex w-full items-center gap-2 px-4 py-1.5 text-left text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover,rgba(255,255,255,0.04))]"
            >
              {s.pinned ? (
                <span aria-hidden="true" className="text-[10px] text-[var(--text-tertiary)]">📌</span>
              ) : null}
              <span className="min-w-0 flex-1 truncate font-mono">{s.path}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function PromptStep({
  daemon,
  label,
  accent,
  host,
  cwd,
  promptRef,
  value,
  onChange,
  canStart,
  onStart,
}: {
  daemon: boolean;
  label: string;
  accent: string;
  host?: string;
  cwd: string;
  promptRef: React.MutableRefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (v: string) => void;
  canStart: boolean;
  onStart: () => void;
}) {
  const title = daemon ? "Start a WALL•E home-agent session" : `Spawn omp on ${label}`;
  const startLabel = daemon ? "Start session" : `Spawn on ${label}`;
  const cwdText = cwd || (daemon ? "/workspace/agent" : "~");
  const sub = daemon ? `Runs on the daemon · ${cwdText}` : `${host ?? label} · ${cwdText}`;
  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      <div className="text-[13px] font-medium text-[var(--text-primary)]" data-testid="new-session-confirm-title">
        {title}
      </div>
      <textarea
        ref={promptRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // Plain Enter inserts a newline; ⌘↵/Ctrl↵ submits (bubbles to dialog).
          if (e.key === "Enter" && !(e.metaKey || e.ctrlKey)) {
            e.stopPropagation();
          }
        }}
        rows={3}
        placeholder={
          daemon
            ? "First message (required to start a home-agent session)"
            : "First message (optional) — leave blank to open an empty session"
        }
        aria-label="First message"
        data-testid="new-session-prompt-input"
        className="resize-none rounded-[6px] border border-[var(--border-secondary,rgba(255,255,255,0.075))] bg-[var(--bg-tertiary,#1c1c21)] px-3 py-2 text-[13px] leading-[1.5] text-[var(--text-primary)] outline-none focus:border-[var(--accent-blue,#5fb4a4)] placeholder:text-[var(--text-muted)]"
      />
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1 text-[11px] text-[var(--text-tertiary)]" data-testid="new-session-confirm-sub">
          Start on{" "}
          <span className="font-semibold" style={{ color: accent }}>{label}</span>
          {" "}· <span className="font-mono">{cwdText}</span>
          <span className="block truncate text-[var(--text-muted)]">{sub}</span>
        </div>
        <button
          type="button"
          onClick={onStart}
          disabled={!canStart}
          data-testid="new-session-start"
          className="shrink-0 rounded-[6px] px-3 py-1.5 text-[11px] font-semibold disabled:cursor-not-allowed disabled:opacity-50"
          style={{ backgroundColor: canStart ? accent : "var(--bg-surface, #22222a)", color: canStart ? "#15151a" : "var(--text-muted)" }}
        >
          {startLabel}
        </button>
      </div>
    </div>
  );
}

/** Derive a 2-letter monogram (same vocabulary as MachineRoster.abbrev). */
function abbrev(label: string, role?: string): string {
  const src = (label || role || "").trim();
  if (!src) return "??";
  const words = src.split(/[\s\-_]+/).filter(Boolean);
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toLowerCase();
  return src.slice(0, 2).toLowerCase();
}

export default NewSessionPopover;
