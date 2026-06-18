/**
 * walle-dash-fixes #6: New Session popover step 3 surfaces optional Model +
 * Thinking-level pickers and emits the chosen values through onStart. Default
 * (empty) selections collapse to `undefined` in the payload, and the curated
 * fallback model list is used only when no registry is supplied.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { NewSessionPopover } from "../NewSessionPopover.js";
import type { MachineRosterEntry } from "../../hooks/useMachineRoster.js";

vi.mock("../../hooks/useMobile.js", () => ({ useMobile: () => false }));

afterEach(() => cleanup());

function makeMachine(over: Partial<MachineRosterEntry> = {}): MachineRosterEntry {
  return {
    id: "mac-laptop",
    label: "Laptop",
    accent: "#5fb4a4",
    addedAt: "2026-06-17T00:00:00Z",
    status: "online",
    sessionCount: 0,
    ...over,
  };
}

/** Drive the popover from step 1 (machine) to step 3 (prompt) with cwd set. */
function gotoPromptStep() {
  fireEvent.click(screen.getByTestId("new-session-machine"));
  const cwd = screen.getByTestId("new-session-cwd-input");
  fireEvent.change(cwd, { target: { value: "/proj" } });
  fireEvent.keyDown(cwd, { key: "Enter" });
}

describe("NewSessionPopover — model + thinking pickers (#6)", () => {
  it("step 3 renders Model + Thinking selects defaulting to the curated fallback", () => {
    render(
      <NewSessionPopover
        open
        machines={[makeMachine()]}
        defaultMachineId="mac-laptop"
        recentCwds={() => []}
        onStart={() => {}}
        onClose={() => {}}
      />,
    );
    gotoPromptStep();

    const model = screen.getByTestId("new-session-model") as HTMLSelectElement;
    const thinking = screen.getByTestId("new-session-thinking") as HTMLSelectElement;
    expect(within(model).getByText("anthropic/claude-opus-4-8")).toBeTruthy();
    // "Default" + 5 levels (minimal..xhigh).
    expect(thinking.querySelectorAll("option").length).toBe(6);
    expect(model.value).toBe("");
    expect(thinking.value).toBe("");
  });

  it("uses the supplied model registry instead of the fallback when present", () => {
    render(
      <NewSessionPopover
        open
        machines={[makeMachine()]}
        defaultMachineId="mac-laptop"
        recentCwds={() => []}
        models={[{ provider: "acme", id: "m1" }]}
        onStart={() => {}}
        onClose={() => {}}
      />,
    );
    gotoPromptStep();

    const model = screen.getByTestId("new-session-model");
    expect(within(model).getByText("acme/m1")).toBeTruthy();
    expect(within(model).queryByText("anthropic/claude-opus-4-8")).toBeNull();
  });

  it("emits chosen model + thinkingLevel through onStart", () => {
    const onStart = vi.fn();
    render(
      <NewSessionPopover
        open
        machines={[makeMachine()]}
        defaultMachineId="mac-laptop"
        recentCwds={() => []}
        onStart={onStart}
        onClose={() => {}}
      />,
    );
    gotoPromptStep();
    fireEvent.change(screen.getByTestId("new-session-model"), {
      target: { value: "anthropic/claude-sonnet-4-5" },
    });
    fireEvent.change(screen.getByTestId("new-session-thinking"), {
      target: { value: "low" },
    });
    fireEvent.click(screen.getByTestId("new-session-start"));

    expect(onStart).toHaveBeenCalledWith({
      machineId: "mac-laptop",
      cwd: "/proj",
      prompt: undefined,
      model: "anthropic/claude-sonnet-4-5",
      thinkingLevel: "low",
    });
  });

  it("collapses Default selections to undefined in the payload", () => {
    const onStart = vi.fn();
    render(
      <NewSessionPopover
        open
        machines={[makeMachine()]}
        defaultMachineId="mac-laptop"
        recentCwds={() => []}
        onStart={onStart}
        onClose={() => {}}
      />,
    );
    gotoPromptStep();
    fireEvent.click(screen.getByTestId("new-session-start"));

    expect(onStart).toHaveBeenCalledWith({
      machineId: "mac-laptop",
      cwd: "/proj",
      prompt: undefined,
      model: undefined,
      thinkingLevel: undefined,
    });
  });
});
