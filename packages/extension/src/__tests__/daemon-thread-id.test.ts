import { describe, it, expect } from "vitest";
import { buildDaemonThreadIdField } from "../daemon-thread-id.js";

describe("buildDaemonThreadIdField", () => {
  it("returns empty when PI_DASHBOARD_THREAD_ID is unset (laptop/remote/upstream)", () => {
    expect(buildDaemonThreadIdField({})).toEqual({});
  });

  it("returns empty when PI_DASHBOARD_THREAD_ID is whitespace-only", () => {
    expect(buildDaemonThreadIdField({ PI_DASHBOARD_THREAD_ID: "   " })).toEqual({});
  });

  it("emits daemonThreadId when PI_DASHBOARD_THREAD_ID is set (dashboard daemon session)", () => {
    expect(buildDaemonThreadIdField({ PI_DASHBOARD_THREAD_ID: "thread-abc123" })).toEqual({
      daemonThreadId: "thread-abc123",
    });
  });

  it("trims surrounding whitespace", () => {
    expect(buildDaemonThreadIdField({ PI_DASHBOARD_THREAD_ID: "  thread-abc123  " })).toEqual({
      daemonThreadId: "thread-abc123",
    });
  });
});
