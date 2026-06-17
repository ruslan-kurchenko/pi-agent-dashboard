/**
 * walle-multi-machine: regression for the shell-crashing sort bug.
 *
 * SessionMiniStrip lives in the layout chrome (collapsed sidebar), so a throw
 * in its sort takes down the whole shell via the top-level ErrorBoundary
 * ("Shell encountered an error"). The original code called
 * `(b.startedAt ?? "").localeCompare(...)`, but `startedAt` is a number
 * (epoch ms) — `number.localeCompare` is not a function → TypeError on every
 * render where a session is present. These tests pin the numeric sort.
 */
import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import { SessionMiniStrip } from "../SessionMiniStrip.js";

function mk(id: string, startedAt: number, status: DashboardSession["status"] = "active"): DashboardSession {
  return { id, cwd: "/workspace", source: "tui", status, startedAt, name: id } as DashboardSession;
}
describe("SessionMiniStrip", () => {
  it("renders without throwing when startedAt is a number (was: localeCompare crash)", () => {
    expect(() =>
      render(
        <SessionMiniStrip
          sessions={[mk("a", 1_000), mk("b", 3_000), mk("c", 2_000)]}
          onSelect={() => {}}
        />,
      ),
    ).not.toThrow();
  });

  it("orders alive-first then by startedAt descending", () => {
    const { container } = render(
      <SessionMiniStrip
        sessions={[
          mk("old-alive", 1_000),
          mk("ended", 9_999, "ended"),
          mk("new-alive", 5_000),
        ]}
        selectedId={null}
        onSelect={() => {}}
      />,
    );
    const order = [...container.querySelectorAll("button")].map((b) => b.getAttribute("title"));
    // alive sessions (by startedAt desc) precede the ended one despite its higher startedAt.
    expect(order.indexOf("new-alive")).toBeLessThan(order.indexOf("old-alive"));
    expect(order.indexOf("old-alive")).toBeLessThan(order.indexOf("ended"));
  });

  it("tolerates a missing startedAt without throwing", () => {
    const s = { id: "x", cwd: "/workspace", source: "tui", status: "active" } as DashboardSession;
    expect(() => render(<SessionMiniStrip sessions={[s, mk("y", 1)]} onSelect={() => {}} />)).not.toThrow();
  });
});
