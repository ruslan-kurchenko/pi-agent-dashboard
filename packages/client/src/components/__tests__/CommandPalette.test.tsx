/**
 * Tests for `CommandPalette`.
 *
 * What we assert (and what we don't):
 *   - Global ⌘K (Cmd+K / Ctrl+K) toggles the palette — open and close.
 *   - Escape on step 1 closes; on later steps it back-steps.
 *   - The machine step lists every entry from the `machines` prop with
 *     the first online row pre-selected.
 *   - Arrow + Enter on step 1 advances to step 2; Esc on step 2 returns.
 *   - Step 2 fuzzy-filters recent cwds by case-insensitive substring.
 *   - Submitting from step 3 invokes `onSpawn(cwd, machineId)` exactly
 *     once with the expected arguments and closes the palette.
 *   - ARIA: dialog has `role=dialog`, `aria-modal=true`, labelled by
 *     the visible title.
 *
 * We intentionally do not assert on focus trap mechanics or
 * focus-restoration — both are best covered by manual a11y review.
 *
 * See change: walle-multi-machine (⌘K command palette for cross-machine spawn).
 */
import React, { useState } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { CommandPalette } from "../CommandPalette.js";
import type { MachineRosterEntry } from "../../hooks/useMachineRoster.js";

afterEach(() => cleanup());

function makeMachine(over: Partial<MachineRosterEntry> = {}): MachineRosterEntry {
  return {
    id: "walle-daemon",
    label: "wall-e daemon",
    accent: "#5fb4a4",
    addedAt: "2026-06-17T00:00:00Z",
    status: "online",
    sessionCount: 2,
    ...over,
  };
}

const threeMachines: MachineRosterEntry[] = [
  makeMachine({ id: "walle-daemon", label: "wall-e daemon", status: "offline", sessionCount: 0 }),
  makeMachine({ id: "mac-work", label: "mac-work", accent: "#b9a3e8", status: "online", sessionCount: 3 }),
  makeMachine({ id: "arch-personal", label: "arch-personal", accent: "#f0a868", status: "idle", sessionCount: 1 }),
];

/**
 * Test harness that mirrors App.tsx's wiring: owns the open boolean and
 * exposes `onOpen` / `onClose` so the palette's document-level ⌘K
 * listener can flip it. Optional `onSpawn` lets a test inject a spy.
 */
function Harness(props: {
  machines?: MachineRosterEntry[];
  initialCwd?: string;
  onSpawn?: (cwd: string, machineId: string) => void;
  recentCwdsForMachine?: (id: string) => string[];
  mobile?: boolean;
  initiallyOpen?: boolean;
}) {
  const [open, setOpen] = useState(props.initiallyOpen ?? false);
  return (
    <CommandPalette
      open={open}
      onOpen={() => setOpen(true)}
      onClose={() => setOpen(false)}
      machines={props.machines ?? threeMachines}
      initialCwd={props.initialCwd}
      recentCwdsForMachine={props.recentCwdsForMachine}
      onSpawn={props.onSpawn ?? (() => {})}
      mobile={props.mobile}
    />
  );
}

function pressCmdK() {
  // ⌘K on Mac, Ctrl+K elsewhere. Both modifiers fire the same handler
  // — we use metaKey here since the listener accepts either.
  fireEvent.keyDown(document, { key: "k", metaKey: true });
}

describe("CommandPalette", () => {
  it("opens on ⌘K", () => {
    render(<Harness />);
    expect(screen.queryByRole("dialog")).toBeNull();

    act(() => { pressCmdK(); });

    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeTruthy();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
  });

  it("closes on a second ⌘K (toggle)", () => {
    render(<Harness initiallyOpen={true} />);
    expect(screen.getByRole("dialog")).toBeTruthy();

    act(() => { pressCmdK(); });

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes on Escape from the first step", () => {
    render(<Harness initiallyOpen={true} />);
    const dialog = screen.getByRole("dialog");

    fireEvent.keyDown(dialog, { key: "Escape" });

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("dialog has role=dialog, aria-modal=true, and aria-labelledby to the title", () => {
    render(<Harness initiallyOpen={true} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const labelId = dialog.getAttribute("aria-labelledby");
    expect(labelId).toBeTruthy();
    const title = document.getElementById(labelId!);
    expect(title?.textContent).toBe("Start session on a machine");
  });

  it("renders one row per machine on step 1", () => {
    render(<Harness initiallyOpen={true} />);
    const rows = screen.getAllByTestId("command-palette-machine");
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.getAttribute("data-machine-id"))).toEqual([
      "walle-daemon",
      "mac-work",
      "arch-personal",
    ]);
  });

  it("preselects the first online machine on open", () => {
    render(<Harness initiallyOpen={true} />);
    const rows = screen.getAllByTestId("command-palette-machine");
    // `mac-work` (idx 1) is the first online — others are offline / idle.
    expect(rows[1]!.getAttribute("data-active")).toBe("true");
    expect(rows[0]!.getAttribute("data-active")).toBe("false");
    expect(rows[2]!.getAttribute("data-active")).toBe("false");
    expect(rows[1]!.getAttribute("aria-selected")).toBe("true");
  });

  it("ArrowDown moves the selection; ArrowUp wraps", () => {
    render(<Harness initiallyOpen={true} />);
    const dialog = screen.getByRole("dialog");

    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    let rows = screen.getAllByTestId("command-palette-machine");
    expect(rows[2]!.getAttribute("data-active")).toBe("true");

    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    rows = screen.getAllByTestId("command-palette-machine");
    // Wraps to first row.
    expect(rows[0]!.getAttribute("data-active")).toBe("true");

    fireEvent.keyDown(dialog, { key: "ArrowUp" });
    rows = screen.getAllByTestId("command-palette-machine");
    expect(rows[2]!.getAttribute("data-active")).toBe("true");
  });

  it("Enter on step 1 advances to step 2; Esc on step 2 back-steps to step 1", () => {
    render(<Harness initiallyOpen={true} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("data-step")).toBe("machine");

    fireEvent.keyDown(dialog, { key: "Enter" });
    expect(screen.getByRole("dialog").getAttribute("data-step")).toBe("cwd");
    expect(screen.getByTestId("command-palette-cwd-input")).toBeTruthy();

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.getByRole("dialog").getAttribute("data-step")).toBe("machine");
  });

  it("pre-fills the cwd input from initialCwd when advancing to step 2", () => {
    render(<Harness initiallyOpen={true} initialCwd="/Users/op/Projects/wall-e" />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });

    const input = screen.getByTestId("command-palette-cwd-input") as HTMLInputElement;
    expect(input.value).toBe("/Users/op/Projects/wall-e");
  });

  it("fuzzy-filters cwd suggestions by case-insensitive substring", () => {
    const cwdsByMachine: Record<string, string[]> = {
      "mac-work": [
        "/Users/op/Projects/wall-e",
        "/Users/op/Projects/khealth/workforce-manager",
        "/Users/op/scratch/notes",
        "/Users/op/Projects/khealth/care-manager",
      ],
    };
    render(
      <Harness
        recentCwdsForMachine={(id) => cwdsByMachine[id] ?? []}
      />,
    );
    act(() => { pressCmdK(); });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });

    // All four cwds visible with empty filter.
    let suggestions = screen.getAllByTestId("command-palette-suggestion");
    expect(suggestions).toHaveLength(4);

    // Substring filter (lowercase against mixed-case paths).
    const input = screen.getByTestId("command-palette-cwd-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "khealth" } });
    suggestions = screen.getAllByTestId("command-palette-suggestion");
    expect(suggestions.map((s) => s.textContent)).toEqual([
      "/Users/op/Projects/khealth/workforce-manager",
      "/Users/op/Projects/khealth/care-manager",
    ]);

    // Case-insensitive — uppercase query still matches.
    fireEvent.change(input, { target: { value: "WALL-E" } });
    suggestions = screen.getAllByTestId("command-palette-suggestion");
    expect(suggestions.map((s) => s.textContent)).toEqual([
      "/Users/op/Projects/wall-e",
    ]);
  });

  it("submitting from step 3 calls onSpawn(cwd, machineId) once and closes", () => {
    const onSpawn = vi.fn();
    render(<Harness initiallyOpen={true} onSpawn={onSpawn} />);

    // Step 1: pre-selected is mac-work (first online). Enter advances.
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });

    // Step 2: type the cwd; Enter advances.
    const input = screen.getByTestId("command-palette-cwd-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "/Users/op/Projects/wall-e" } });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });

    // Step 3: Enter submits.
    expect(screen.getByRole("dialog").getAttribute("data-step")).toBe("confirm");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });

    expect(onSpawn).toHaveBeenCalledTimes(1);
    expect(onSpawn).toHaveBeenCalledWith("/Users/op/Projects/wall-e", "mac-work");

    // Palette closed after submit.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Enter on step 2 does nothing when cwd is empty", () => {
    render(<Harness initiallyOpen={true} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });
    expect(screen.getByRole("dialog").getAttribute("data-step")).toBe("cwd");

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });
    // Still on cwd step.
    expect(screen.getByRole("dialog").getAttribute("data-step")).toBe("cwd");
  });

  it("renders the floating + button in mobile mode and not on desktop", () => {
    const { rerender } = render(<Harness mobile />);
    expect(screen.getByTestId("command-palette-fab")).toBeTruthy();

    rerender(<Harness />);
    expect(screen.queryByTestId("command-palette-fab")).toBeNull();
  });
});
