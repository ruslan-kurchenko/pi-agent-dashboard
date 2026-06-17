/**
 * Tests for `MachineRoster`.
 *
 * What we assert (and don't):
 *   - One card per machine in the input list (rendering loop).
 *   - Accent square uses `machine.accent` verbatim (the curated palette
 *     lives upstream in wall-e — UI must not pick its own).
 *   - Status dot color matches the SOTA mockup palette
 *     (online=#5ed09a, idle=#b9b9c0, offline=#6a6a72).
 *   - Click toggles the filter: `onMachineSelect(id)` on activate,
 *     `onMachineSelect(null)` on re-click of the active card.
 *   - Active card sticks a ring outline (data-active="true").
 *   - 0 machines = render nothing (empty roster, framework default).
 *
 * See change: walle-multi-machine.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MachineRoster } from "../MachineRoster.js";
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

describe("MachineRoster", () => {
  it("renders nothing when machines is empty", () => {
    const { container } = render(
      <MachineRoster machines={[]} onMachineSelect={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders one card per machine", () => {
    const machines: MachineRosterEntry[] = [
      makeMachine({ id: "walle-daemon", label: "wall-e daemon" }),
      makeMachine({ id: "mac-work", label: "mac-work", accent: "#b9a3e8", status: "idle", sessionCount: 0 }),
      makeMachine({ id: "arch-personal", label: "arch-personal", accent: "#f0a868", status: "offline", sessionCount: 0 }),
    ];

    render(<MachineRoster machines={machines} onMachineSelect={() => {}} />);

    const cards = screen.getAllByTestId("machine-roster-card");
    expect(cards).toHaveLength(3);
    expect(cards.map((c) => c.getAttribute("data-machine-id"))).toEqual([
      "walle-daemon",
      "mac-work",
      "arch-personal",
    ]);
  });

  it("paints accent square with the machine's curated color", () => {
    render(
      <MachineRoster
        machines={[makeMachine({ accent: "#5fb4a4" })]}
        onMachineSelect={() => {}}
      />,
    );
    const accent = screen.getByTestId("machine-roster-accent");
    // jsdom normalizes inline style; compare via the style prop.
    expect((accent as HTMLElement).style.backgroundColor).toBe("rgb(95, 180, 164)");
  });

  it("falls back when accent is missing", () => {
    const machine = makeMachine();
    delete (machine as { accent?: string }).accent;
    render(<MachineRoster machines={[machine]} onMachineSelect={() => {}} />);
    const accent = screen.getByTestId("machine-roster-accent");
    expect((accent as HTMLElement).style.backgroundColor).toContain("var(--text-tertiary)");
  });

  it("colors the status dot for online/idle/offline", () => {
    const machines: MachineRosterEntry[] = [
      makeMachine({ id: "a", status: "online" }),
      makeMachine({ id: "b", status: "idle" }),
      makeMachine({ id: "c", status: "offline" }),
    ];
    render(<MachineRoster machines={machines} onMachineSelect={() => {}} />);

    const dots = screen.getAllByTestId("machine-roster-dot");
    expect((dots[0] as HTMLElement).style.backgroundColor).toBe("rgb(94, 208, 154)"); // #5ed09a
    expect((dots[1] as HTMLElement).style.backgroundColor).toBe("rgb(185, 185, 192)"); // #b9b9c0
    expect((dots[2] as HTMLElement).style.backgroundColor).toBe("rgb(106, 106, 114)"); // #6a6a72
  });

  it("invokes onMachineSelect(id) when an inactive card is clicked", () => {
    const onSelect = vi.fn();
    render(
      <MachineRoster
        machines={[makeMachine({ id: "walle-daemon" })]}
        selectedMachineId={null}
        onMachineSelect={onSelect}
      />,
    );

    fireEvent.click(screen.getByTestId("machine-roster-card"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("walle-daemon");
  });

  it("invokes onMachineSelect(null) when the active card is re-clicked (toggle off)", () => {
    const onSelect = vi.fn();
    render(
      <MachineRoster
        machines={[makeMachine({ id: "walle-daemon" })]}
        selectedMachineId="walle-daemon"
        onMachineSelect={onSelect}
      />,
    );

    fireEvent.click(screen.getByTestId("machine-roster-card"));
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it("marks the active card data-active=true and inactive cards false", () => {
    const machines: MachineRosterEntry[] = [
      makeMachine({ id: "a" }),
      makeMachine({ id: "b" }),
    ];
    render(
      <MachineRoster
        machines={machines}
        selectedMachineId="b"
        onMachineSelect={() => {}}
      />,
    );

    const cards = screen.getAllByTestId("machine-roster-card");
    expect(cards[0].getAttribute("data-active")).toBe("false");
    expect(cards[1].getAttribute("data-active")).toBe("true");
    // Tailwind ring utility lands as a class string on the active card.
    expect(cards[1].className).toMatch(/\bring-1\b/);
  });

  it("renders sessionCount per card", () => {
    render(
      <MachineRoster
        machines={[
          makeMachine({ id: "a", sessionCount: 0 }),
          makeMachine({ id: "b", sessionCount: 7 }),
        ]}
        onMachineSelect={() => {}}
      />,
    );
    const counts = screen.getAllByTestId("machine-roster-count");
    expect(counts.map((c) => c.textContent)).toEqual(["0", "7"]);
  });

  it("dims (60% opacity) when 0 sessions AND status=offline", () => {
    const machines: MachineRosterEntry[] = [
      makeMachine({ id: "lit", sessionCount: 0, status: "online" }),
      makeMachine({ id: "dim", sessionCount: 0, status: "offline" }),
      makeMachine({ id: "busy-offline", sessionCount: 3, status: "offline" }),
    ];
    render(<MachineRoster machines={machines} onMachineSelect={() => {}} />);

    const [a, b, c] = screen.getAllByTestId("machine-roster-card");
    expect(a.className).not.toMatch(/opacity-60/);
    expect(b.className).toMatch(/opacity-60/);
    expect(c.className).not.toMatch(/opacity-60/);
  });
});
