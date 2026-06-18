/**
 * Verifies that wireEvents() translates a bridge-emitted
 * `spawn_on_machine_failed` into a `spawn_error` broadcast so the existing
 * browser banner machinery handles cross-machine failures uniformly.
 * No timers, no real WS — wireEvents is invoked with stubbed gateways
 * and the onEvent callback is driven synchronously.
 * See change: walle-multi-machine.
 */
import { describe, it, expect, vi } from "vitest";
import { wireEvents, type EventWiringDeps } from "../event-wiring.js";
import type { PiGateway } from "../pi-gateway.js";
import type { BrowserGateway } from "../browser-gateway.js";
import type { SessionManager } from "../memory-session-manager.js";
import type { EventStore } from "../memory-event-store.js";
import type { SessionOrderManager } from "../session-order-manager.js";
import type { PreferencesStore } from "../preferences-store.js";
import type { DirectoryService } from "../directory-service.js";
import type { PendingForkRegistry } from "../pending-fork-registry.js";

function buildDeps(): {
  deps: EventWiringDeps;
  piGateway: { onEvent?: PiGateway["onEvent"] };
  broadcasts: unknown[];
} {
  const broadcasts: unknown[] = [];
  const piGateway = {
    onEvent: undefined as PiGateway["onEvent"],
    onDisconnect: undefined,
    onConnection: undefined,
    onSessionRegistered: undefined,
    onEmpty: undefined,
    onSessionCreated: undefined,
  } as unknown as PiGateway;
  const browserGateway = {
    broadcastToAll: vi.fn((msg: unknown) => { broadcasts.push(msg); }),
    broadcastSessionUpdated: vi.fn(),
    broadcastEvent: vi.fn(),
    sendToSubscribers: vi.fn(),
    getSubscriberCount: vi.fn(() => 0),
  } as unknown as BrowserGateway;
  const sessionManager = {
    onUnregister: undefined,
    get: vi.fn(),
    update: vi.fn(),
    listAll: vi.fn(() => []),
  } as unknown as SessionManager;
  const eventStore = {
    insertEvent: vi.fn(() => 1),
    getEvent: vi.fn(),
  } as unknown as EventStore;
  const sessionOrderManager = {
    add: vi.fn(),
    remove: vi.fn(),
    getAllOrders: vi.fn(() => ({})),
  } as unknown as SessionOrderManager;
  const preferencesStore = {
    isPinned: vi.fn(() => false),
  } as unknown as PreferencesStore;
  const directoryService = {} as unknown as DirectoryService;
  const pendingForkRegistry = { consume: vi.fn(), record: vi.fn() } as unknown as PendingForkRegistry;

  const deps: EventWiringDeps = {
    sessionManager,
    eventStore,
    piGateway,
    browserGateway,
    sessionOrderManager,
    preferencesStore,
    pendingForkRegistry,
    directoryService,
    knownSessionIds: new Set<string>(),
    pendingDashboardSpawns: new Map<string, number>(),
  };

  return { deps, piGateway: piGateway as unknown as { onEvent?: PiGateway["onEvent"] }, broadcasts };
}

describe("event-wiring: spawn_on_machine_failed → spawn_error forwarder", () => {
  it("translates an AGENT_DIDNT_REGISTER bridge failure into a spawn_error broadcast", () => {
    const { deps, piGateway, broadcasts } = buildDeps();
    wireEvents(deps);

    // Drive the bridge frame the way pi-gateway would.
    piGateway.onEvent!("ignored-session-id", {
      type: "spawn_on_machine_failed",
      requestId: "req-abc",
      cwd: "/repo/foo",
      code: "AGENT_DIDNT_REGISTER",
      message: "Agent did not register within 30s",
    } as never);

    expect(broadcasts).toEqual([
      {
        type: "spawn_error",
        cwd: "/repo/foo",
        strategy: "remote",
        message: "Agent did not register within 30s",
        code: "AGENT_DIDNT_REGISTER",
        requestId: "req-abc",
      },
    ]);
  });

  it("translates AGENT_INVOKE_FAILED the same way (different code, same envelope)", () => {
    const { deps, piGateway, broadcasts } = buildDeps();
    wireEvents(deps);

    piGateway.onEvent!("s", {
      type: "spawn_on_machine_failed",
      requestId: "req-xyz",
      cwd: "/path",
      code: "AGENT_INVOKE_FAILED",
      message: "omp binary not found",
    } as never);

    expect(broadcasts).toHaveLength(1);
    const out = broadcasts[0] as Record<string, unknown>;
    expect(out.type).toBe("spawn_error");
    expect(out.code).toBe("AGENT_INVOKE_FAILED");
    expect(out.strategy).toBe("remote");
    expect(out.requestId).toBe("req-xyz");
  });

  it("does NOT fall through to the event_forward branch", () => {
    // The forwarder must `return` after broadcasting, otherwise the
    // downstream `event_forward` shape access (`msg.event.eventType`)
    // would throw.
    const { deps, piGateway } = buildDeps();
    wireEvents(deps);

    expect(() => {
      piGateway.onEvent!("s", {
        type: "spawn_on_machine_failed",
        requestId: "req",
        cwd: "/p",
        code: "MACHINE_OFFLINE",
        message: "x",
      } as never);
    }).not.toThrow();
  });
});

describe("event-wiring: resume_on_machine_failed → resume_result forwarder", () => {
  it("translates a bridge resume failure into a resume_result error broadcast", () => {
    const { deps, piGateway, broadcasts } = buildDeps();
    wireEvents(deps);

    piGateway.onEvent!("ignored-session-id", {
      type: "resume_on_machine_failed",
      requestId: "req-r9",
      sessionId: "s-remote",
      code: "AGENT_DIDNT_REGISTER",
      detail: "Resumed agent did not register within the watchdog window",
    } as never);

    expect(broadcasts).toEqual([
      {
        type: "resume_result",
        sessionId: "s-remote",
        success: false,
        message: "Resumed agent did not register within the watchdog window",
        requestId: "req-r9",
      },
    ]);
  });

  it("falls back to the code when no detail is provided", () => {
    const { deps, piGateway, broadcasts } = buildDeps();
    wireEvents(deps);

    piGateway.onEvent!("s", {
      type: "resume_on_machine_failed",
      requestId: "req-r10",
      sessionId: "s-remote",
      code: "AGENT_INVOKE_FAILED",
    } as never);

    expect(broadcasts).toHaveLength(1);
    const out = broadcasts[0] as Record<string, unknown>;
    expect(out.type).toBe("resume_result");
    expect(out.success).toBe(false);
    expect(out.message).toBe("AGENT_INVOKE_FAILED");
    expect(out.requestId).toBe("req-r10");
  });

  it("does NOT fall through to the event_forward branch", () => {
    const { deps, piGateway } = buildDeps();
    wireEvents(deps);
    expect(() => {
      piGateway.onEvent!("s", {
        type: "resume_on_machine_failed",
        requestId: "req",
        sessionId: "s",
        code: "X",
      } as never);
    }).not.toThrow();
  });
});
