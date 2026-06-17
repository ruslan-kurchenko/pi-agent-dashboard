/**
 * CommandPalette — ⌘K cross-machine spawn entry point.
 *
 * A three-step modal flow:
 *
 *   1. Machine picker — operator picks the machine to spawn on.
 *      First online machine is preselected. Arrow keys navigate,
 *      Enter advances, Esc closes (since this is the first step).
 *
 *   2. cwd field — free-text input pre-filled with the currently
 *      focused session's cwd (when one exists). Filters the
 *      currently-selected machine's recent cwds by case-insensitive
 *      substring as the operator types. Enter advances. Esc back-steps.
 *
 *   3. Confirm — single-line summary `Start on <label> in <cwd>`.
 *      Enter submits + closes; Esc back-steps to the cwd field.
 *
 * Open/close model
 *
 *   The palette is controlled — App owns the boolean and passes both
 *   `onOpen` and `onClose`. The palette is the single place that
 *   installs the document-level ⌘K (Cmd+K on Mac, Ctrl+K elsewhere)
 *   listener; it calls back into the parent's `onOpen` / `onClose`.
 *   Co-locating the keyboard logic with the consumer of `open` keeps
 *   the App.tsx wiring trivial and the listener trivially testable.
 *
 *   Esc closes (or back-steps); click-outside on the backdrop closes;
 *   focus is restored to whatever element held it before open.
 *
 * Mobile variant
 *
 *   `mobile` swaps the centered modal for a bottom-anchored sheet and
 *   exposes a floating accent-colored `+` button (the only mobile
 *   entry point — there is no keyboard shortcut on touch devices).
 *   The FAB's accent uses the first online machine (then first machine
 *   in the roster) so the operator's primary target is always one tap
 *   away. Header gains a back chevron on steps 2 and 3.
 *
 * See change: walle-multi-machine (⌘K command palette for cross-machine spawn).
 */
import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { DialogPortal } from "./DialogPortal.js";
import type { MachineRosterEntry, MachineStatus } from "../hooks/useMachineRoster.js";

// Roster-step status dot. Same vocabulary as MachineRoster.tsx so the
// chip + roster + palette stay visually consistent. See change:
// walle-multi-machine (Phase 2 — machine roster UI).
const STATUS_DOT_COLOR: Record<MachineStatus, string> = {
  online: "#5ed09a",
  idle: "#b9b9c0",
  offline: "#6a6a72",
  unreachable: "#d97757",
};

type Step = "machine" | "cwd" | "confirm";

export interface CommandPaletteProps {
  open: boolean;
  /** Called when ⌘K is pressed while the palette is closed. */
  onOpen: () => void;
  /** Called by Escape (from step 1), backdrop click, ⌘K toggle, or successful submit. */
  onClose: () => void;
  /** Roster of configured machines — pass `useMachineRoster().machines`. */
  machines: MachineRosterEntry[];
  /**
   * Pre-fill for the cwd input on step 2. Pass the currently focused
   * session's cwd (or omit). The operator can always overwrite.
   */
  initialCwd?: string;
  /**
   * Returns recent cwds for the given machine id. Used for the case-
   * insensitive substring autocomplete in step 2. App derives this
   * from its sessions Map so the palette stays stateless about
   * session storage.
   */
  recentCwdsForMachine?: (machineId: string) => string[];
  /**
   * Invoked on submit with the operator-chosen cwd and the target
   * machine id. The host should turn this into a `spawn_session`
   * frame with `{ cwd, machineId }`.
   */
  onSpawn: (cwd: string, machineId: string) => void;
  /** Render the bottom-sheet variant and expose the FAB entry point. */
  mobile?: boolean;
  /**
   * Optional toast emitter. Called after a successful submit with
   * `Spawning on <label>…`. Falls back to `console.info` when omitted.
   */
  onToast?: (text: string) => void;
}

export function CommandPalette({
  open,
  onOpen,
  onClose,
  machines,
  initialCwd = "",
  recentCwdsForMachine,
  onSpawn,
  mobile = false,
  onToast,
}: CommandPaletteProps) {
  const [step, setStep] = useState<Step>("machine");
  const [machineIdx, setMachineIdx] = useState(0);
  const [cwd, setCwd] = useState(initialCwd);

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  // Index of the first online machine — preselected on every open. If
  // there is no online machine we still want a valid index, so fall back
  // to 0. The empty-roster case is short-circuited in the render so we
  // never compute it for `machines.length === 0`.
  const firstOnlineIdx = useMemo(() => {
    const i = machines.findIndex((m) => m.status === "online");
    return i >= 0 ? i : 0;
  }, [machines]);

  // Reset the flow state every time the palette opens — opening
  // mid-flow always starts at step 1 with the preselected machine and
  // the latest `initialCwd`.
  useEffect(() => {
    if (!open) return;
    setStep("machine");
    setMachineIdx(firstOnlineIdx);
    setCwd(initialCwd);
  }, [open, firstOnlineIdx, initialCwd]);

  // Focus management: snapshot the active element on open, restore on
  // close. Inside the dialog we focus the first focusable (input on
  // cwd step, first machine row on step 1) so keyboard nav lands
  // somewhere predictable.
  useEffect(() => {
    if (!open) {
      previousFocusRef.current?.focus?.();
      previousFocusRef.current = null;
      return;
    }
    previousFocusRef.current = document.activeElement as HTMLElement | null;
  }, [open]);

  // Per-step initial focus. Re-runs when the step changes so step 2's
  // input is focused as soon as the operator advances from the machine
  // picker.
  useEffect(() => {
    if (!open) return;
    if (step === "cwd") {
      inputRef.current?.focus();
      // Place caret at end so the pre-filled cwd is easy to extend.
      const el = inputRef.current;
      if (el) {
        const len = el.value.length;
        try { el.setSelectionRange(len, len); } catch { /* ignore */ }
      }
      return;
    }
    // For machine / confirm steps, focus the dialog container so the
    // document-level keydown reaches us even before the operator
    // clicks anything.
    dialogRef.current?.focus();
  }, [open, step]);

  // Trap Tab inside the dialog when open. Minimal implementation:
  // wrap focus when the operator tabs past either end of the dialog's
  // focusable set. Skips when no focusables (defensive).
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

  const selectedMachine = machines[machineIdx];

  const filteredCwds = useMemo(() => {
    if (!selectedMachine || !recentCwdsForMachine) return [];
    const all = recentCwdsForMachine(selectedMachine.id);
    const q = cwd.trim().toLowerCase();
    if (!q) return all.slice(0, 8);
    return all.filter((p) => p.toLowerCase().includes(q)).slice(0, 8);
  }, [selectedMachine, cwd, recentCwdsForMachine]);

  const submit = useCallback(() => {
    const value = cwd.trim();
    if (!selectedMachine || !value) return;
    onSpawn(value, selectedMachine.id);
    const msg = `Spawning on ${selectedMachine.label}…`;
    if (onToast) onToast(msg);
    else console.info(msg);
    onClose();
  }, [selectedMachine, cwd, onSpawn, onToast, onClose]);

  // Document-level ⌘K toggle: fires regardless of focus location so
  // the operator can pop the palette mid-typing. PreventDefault to
  // suppress Chrome/Safari's address-bar focus shortcut on ⌘K.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isCmdK = (e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey);
      if (!isCmdK) return;
      e.preventDefault();
      if (open) onClose();
      else onOpen();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onOpen, onClose]);

  // Esc / Arrow / Enter handling on the dialog container. Keydowns
  // from the input bubble here, so the same handler covers all steps.
  const handleDialogKey = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (step === "machine") onClose();
        else if (step === "cwd") setStep("machine");
        else if (step === "confirm") setStep("cwd");
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
          if (machines[machineIdx]) setStep("cwd");
        }
        return;
      }
      if (step === "cwd") {
        if (e.key === "Enter") {
          e.preventDefault();
          if (cwd.trim()) setStep("confirm");
        }
        return;
      }
      if (step === "confirm") {
        if (e.key === "Enter") {
          e.preventDefault();
          submit();
        }
      }
    },
    [step, machines, machineIdx, cwd, onClose, submit],
  );

  // FAB accent — first online machine, else first machine. Empty
  // roster → no FAB (the operator has no target anyway).
  const fabAccent = useMemo(() => {
    if (machines.length === 0) return undefined;
    const top = machines.find((m) => m.status === "online") ?? machines[0]!;
    return top.accent ?? "var(--text-tertiary)";
  }, [machines]);

  return (
    <>
      {mobile && !open && fabAccent ? (
        <button
          type="button"
          onClick={onOpen}
          aria-label="Start session on a machine"
          data-testid="command-palette-fab"
          className="fixed bottom-5 right-5 z-40 flex h-12 w-12 items-center justify-center rounded-full text-white text-2xl leading-none shadow-lg"
          style={{ backgroundColor: fabAccent }}
        >
          +
        </button>
      ) : null}

      {open ? (
        <DialogPortal>
          <div
            data-testid="command-palette-backdrop"
            className={`fixed inset-0 z-50 bg-black/55 backdrop-blur-sm flex ${
              mobile
                ? "items-end justify-center"
                : "items-start justify-center pt-20"
            }`}
            onClick={onClose}
          >
            <div
              ref={dialogRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby="command-palette-title"
              data-testid="command-palette"
              data-step={step}
              tabIndex={-1}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={handleDialogKey}
              className={`outline-none bg-[var(--bg-secondary,#1a1a1f)] border border-[var(--border-secondary,#2a2a32)] shadow-[0_24px_60px_rgba(0,0,0,0.6)] flex flex-col ${
                mobile
                  ? "w-full max-h-[80vh] rounded-t-xl"
                  : "w-[600px] max-w-[92vw] rounded-xl overflow-hidden"
              }`}
            >
              <PaletteHeader
                step={step}
                mobile={mobile}
                onBack={() => {
                  if (step === "cwd") setStep("machine");
                  else if (step === "confirm") setStep("cwd");
                }}
              />

              {step === "machine" ? (
                <MachineStep
                  machines={machines}
                  activeIdx={machineIdx}
                  onHover={setMachineIdx}
                  onSelect={(idx) => {
                    setMachineIdx(idx);
                    setStep("cwd");
                  }}
                />
              ) : step === "cwd" ? (
                <CwdStep
                  machine={selectedMachine}
                  inputRef={inputRef}
                  value={cwd}
                  onChange={setCwd}
                  suggestions={filteredCwds}
                  onPickSuggestion={(s) => {
                    setCwd(s);
                    setStep("confirm");
                  }}
                />
              ) : (
                <ConfirmStep machine={selectedMachine} cwd={cwd.trim()} onSubmit={submit} />
              )}

              <PaletteFooter step={step} />
            </div>
          </div>
        </DialogPortal>
      ) : null}
    </>
  );
}

// ── Subcomponents ────────────────────────────────────────────────

function PaletteHeader({
  step,
  mobile,
  onBack,
}: {
  step: Step;
  mobile: boolean;
  onBack: () => void;
}) {
  const showBack = step !== "machine";
  const stepNum = step === "machine" ? 1 : step === "cwd" ? 2 : 3;
  return (
    <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--border-secondary,#2a2a32)]">
      {/* Mobile-only back chevron so touch users can step back without a keyboard. */}
      {mobile && showBack ? (
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          data-testid="command-palette-back"
          className="flex h-6 w-6 items-center justify-center rounded text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
        >
          ‹
        </button>
      ) : null}
      <h2
        id="command-palette-title"
        className="flex-1 text-[13px] font-medium text-[var(--text-primary)]"
      >
        Start session on a machine
      </h2>
      <span
        aria-hidden="true"
        className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-tertiary)]"
      >
        Step {stepNum} of 3
      </span>
    </div>
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
  if (machines.length === 0) {
    return (
      <div className="px-4 py-6 text-[12px] text-[var(--text-tertiary)]">
        No machines configured.
      </div>
    );
  }
  return (
    <div role="listbox" aria-label="Machines" className="py-2 max-h-[60vh] overflow-y-auto">
      {machines.map((m, i) => {
        const active = i === activeIdx;
        const status = m.status ?? "offline";
        const dot = STATUS_DOT_COLOR[status] ?? STATUS_DOT_COLOR.offline;
        const accent = m.accent ?? "var(--text-tertiary)";
        return (
          <button
            key={m.id}
            type="button"
            role="option"
            aria-selected={active}
            data-testid="command-palette-machine"
            data-machine-id={m.id}
            data-active={active ? "true" : "false"}
            onClick={() => onSelect(i)}
            onMouseEnter={() => onHover(i)}
            className={`w-full grid grid-cols-[18px_1fr_auto] items-center gap-3 px-4 py-2 text-left text-[13px] ${
              active
                ? "bg-[var(--bg-tertiary,rgba(255,255,255,0.04))] text-[var(--text-primary)]"
                : "text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary,rgba(255,255,255,0.04))]"
            }`}
          >
            <span
              aria-hidden="true"
              className="block h-[18px] w-[18px] rounded-[4px]"
              style={{ backgroundColor: accent }}
            />
            <span className="min-w-0">
              <span className="block truncate font-medium">{m.label}</span>
              <span className="block truncate text-[11px] text-[var(--text-tertiary)]">
                {m.id}
                {m.role ? <span className="opacity-70"> · {m.role}</span> : null}
              </span>
            </span>
            <span className="flex items-center gap-2 text-[11px] text-[var(--text-tertiary)]">
              <span
                aria-hidden="true"
                className="inline-block h-[6px] w-[6px] rounded-full"
                style={{ backgroundColor: dot }}
              />
              <span>{status}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function CwdStep({
  machine,
  inputRef,
  value,
  onChange,
  suggestions,
  onPickSuggestion,
}: {
  machine: MachineRosterEntry | undefined;
  inputRef: React.MutableRefObject<HTMLInputElement | null>;
  value: string;
  onChange: (v: string) => void;
  suggestions: string[];
  onPickSuggestion: (s: string) => void;
}) {
  return (
    <div className="flex flex-col">
      <div className="px-4 pt-3 pb-2 text-[11px] text-[var(--text-tertiary)]">
        Spawn on{" "}
        <span className="text-[var(--text-secondary)] font-medium">
          {machine?.label ?? "?"}
        </span>
        . Enter a working directory.
      </div>
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="/path/to/project"
        aria-label="Working directory"
        data-testid="command-palette-cwd-input"
        className="mx-4 mb-2 rounded border border-[var(--border-secondary,#2a2a32)] bg-[var(--bg-tertiary,#13131a)] px-3 py-2 text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--border-focus,#5fb4a4)]"
      />
      {suggestions.length > 0 ? (
        <div
          role="listbox"
          aria-label="Recent cwds"
          data-testid="command-palette-suggestions"
          className="border-t border-[var(--border-secondary,#2a2a32)] py-1 max-h-[40vh] overflow-y-auto"
        >
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              role="option"
              aria-selected={false}
              data-testid="command-palette-suggestion"
              onClick={() => onPickSuggestion(s)}
              className="block w-full truncate px-4 py-1.5 text-left text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary,rgba(255,255,255,0.04))]"
            >
              {s}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ConfirmStep({
  machine,
  cwd,
  onSubmit,
}: {
  machine: MachineRosterEntry | undefined;
  cwd: string;
  onSubmit: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      <div
        data-testid="command-palette-summary"
        className="text-[13px] text-[var(--text-primary)]"
      >
        Start on{" "}
        <span className="font-semibold" style={{ color: machine?.accent }}>
          {machine?.label ?? "?"}
        </span>{" "}
        in <span className="font-mono text-[12px]">{cwd}</span>
      </div>
      <button
        type="button"
        onClick={onSubmit}
        data-testid="command-palette-confirm"
        className="self-end rounded bg-[var(--accent-primary,#5fb4a4)] px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-90"
      >
        Start session
      </button>
    </div>
  );
}

function PaletteFooter({ step }: { step: Step }) {
  return (
    <div className="flex gap-4 px-4 py-2 border-t border-[var(--border-secondary,#2a2a32)] text-[10px] text-[var(--text-tertiary)]">
      {step === "machine" ? (
        <>
          <span><kbd>↑↓</kbd> navigate</span>
          <span><kbd>↵</kbd> select</span>
          <span><kbd>esc</kbd> close</span>
        </>
      ) : (
        <>
          <span><kbd>↵</kbd> next</span>
          <span><kbd>esc</kbd> back</span>
        </>
      )}
    </div>
  );
}
