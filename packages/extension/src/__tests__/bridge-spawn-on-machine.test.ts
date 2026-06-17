/**
 * walle-multi-machine: integration shape for the `spawn_on_machine`
 * code path the bridge wires up in `bridge.ts`.
 *
 * `bridge.ts` is too large + bound to live pi APIs to instantiate from a
 * unit test; instead we drive the SAME wiring shape the bridge installs:
 *
 *   - inbound WS frames of `type: "spawn_on_machine"` route into
 *     `handler.handle()`,
 *   - outbound `connection.send` is wrapped so every `session_register`
 *     passes through `handler.onSessionRegister()`,
 *   - all other message types are forwarded verbatim.
 *
 * Failure or contract breakage here would slip past the pure
 * handler test (which doesn't know about the wrapper) and the existing
 * bridge tests (which don't know about the handler). Keeps both halves
 * locked together.
 *
 * See change: walle-multi-machine.
 */
import { describe, it, expect } from "vitest";
import { createSpawnOnMachineHandler } from "../spawn-on-machine-handler.js";
import type {
  SessionRegisterMessage,
  SpawnOnMachineExtensionMessage,
} from "@blackbelt-technology/pi-dashboard-shared/protocol.js";

/**
 * Mirror of the wire-up `bridge.ts` installs around `new ConnectionManager`.
 * Returns the handler-tagged `send` plus the simulated WS `onMessage`
 * dispatcher so the test drives the bridge code path end-to-end without
 * the rest of the bridge's pi/extension wiring.
 */
function wireBridgeShape() {
  const sentFrames: unknown[] = [];
  const invocations: Array<{ cwd: string; opts: { attachProposal?: string; gitWorktreeBase?: string } }> = [];
  const clock = { value: 1_000_000 };

  // The bridge holds `rawConnectionSend` for the spawn handler so its
  // `spawn_on_machine_failed` frames bypass the session_register tagger.
  const rawSend = (msg: unknown) => sentFrames.push(msg);

  const handler = createSpawnOnMachineHandler({
    sendUpstream: rawSend,
    invokeLocalAgent: async (cwd, opts) => {
      invocations.push({ cwd, opts });
    },
    now: () => clock.value,
    logger: { warn: () => {}, error: () => {} },
  });

  // Wrapped send (mirrors `(connection as ...).send = (msg) => ...` in bridge.ts).
  const wrappedSend = (msg: unknown): void => {
    if (msg && (msg as { type?: string }).type === "session_register") {
      rawSend(handler.onSessionRegister(msg as SessionRegisterMessage));
      return;
    }
    rawSend(msg);
  };

  // Simulated WS onMessage dispatcher (mirrors the spawn_on_machine branch
  // in bridge.ts's `onMessage: safe(async (data) => …)`).
  const onMessage = async (data: unknown): Promise<void> => {
    const msg = data as { type: string };
    if (msg.type === "spawn_on_machine") {
      await handler.handle(data as SpawnOnMachineExtensionMessage);
      return;
    }
    // Other types are out of scope here — pretend the rest of the bridge
    // would handle them. We don't need to model that for these tests.
  };

  return { sentFrames, invocations, clock, handler, wrappedSend, onMessage };
}

describe("bridge ↔ spawn-on-machine wiring", () => {
  it("invokes the local agent on inbound spawn_on_machine and tags the next session_register", async () => {
    const wired = wireBridgeShape();

    // Server emits a cross-machine spawn frame.
    await wired.onMessage({
      type: "spawn_on_machine",
      requestId: "req-cross-1",
      cwd: "/home/op/proj",
      attachProposal: "add-feature",
      gitWorktreeBase: "main",
    });

    expect(wired.invocations).toEqual([
      { cwd: "/home/op/proj", opts: { attachProposal: "add-feature", gitWorktreeBase: "main" } },
    ]);
    expect(wired.sentFrames).toEqual([]); // no failure, nothing sent yet

    // The freshly-spawned agent's bridge later emits its first session_register.
    // bridge.ts pipes it through wrappedSend; the handler tags it.
    wired.wrappedSend({
      type: "session_register",
      sessionId: "new-sess",
      cwd: "/home/op/proj",
      source: "dashboard",
    } satisfies SessionRegisterMessage);

    expect(wired.sentFrames).toHaveLength(1);
    expect(wired.sentFrames[0]).toMatchObject({
      type: "session_register",
      sessionId: "new-sess",
      cwd: "/home/op/proj",
      spawnRequestId: "req-cross-1",
    });
  });

  it("passes through unrelated session_register messages verbatim (no spawnRequestId)", () => {
    const wired = wireBridgeShape();

    const incoming: SessionRegisterMessage = {
      type: "session_register",
      sessionId: "any",
      cwd: "/some/other/path",
      source: "tui",
    };
    wired.wrappedSend(incoming);

    expect(wired.sentFrames).toHaveLength(1);
    const out = wired.sentFrames[0] as Record<string, unknown>;
    expect(out.spawnRequestId).toBeUndefined();
    // The wrapper returns the SAME reference when there's no match — the
    // tagger has no work to do.
    expect(out).toBe(incoming);
  });

  it("forwards non-session_register frames untouched through the wrapped send", () => {
    const wired = wireBridgeShape();

    // Pretend the bridge is forwarding a heartbeat.
    const heartbeat = { type: "session_heartbeat", sessionId: "s", metrics: {} };
    wired.wrappedSend(heartbeat);
    expect(wired.sentFrames[0]).toBe(heartbeat);
  });

  it("emits spawn_on_machine_failed upstream when the handler times out", async () => {
    const wired = wireBridgeShape();
    await wired.onMessage({
      type: "spawn_on_machine",
      requestId: "req-timeout",
      cwd: "/lost/spawn",
    });
    // Bridge's interval timer would normally call tickTimeouts(). We
    // simulate the time advance + tick by hand.
    wired.clock.value += 31_000;
    wired.handler.tickTimeouts();

    // The failure frame goes through rawSend (bypassing the
    // session_register tagger), so the wrapper doesn't try to interpret
    // its type.
    expect(wired.sentFrames).toEqual([
      {
        type: "spawn_on_machine_failed",
        requestId: "req-timeout",
        cwd: "/lost/spawn",
        code: "AGENT_DIDNT_REGISTER",
        message: expect.stringContaining("did not send session_register within"),
      },
    ]);
  });

  it("preserves bridge-only fields when tagging session_register", async () => {
    const wired = wireBridgeShape();
    await wired.onMessage({
      type: "spawn_on_machine",
      requestId: "req-fields",
      cwd: "/path/with/fields",
    });

    const incoming: SessionRegisterMessage = {
      type: "session_register",
      sessionId: "s1",
      cwd: "/path/with/fields",
      source: "dashboard",
      machineId: "arch-personal",
      machineLabel: "Arch",
      machineAccent: "#f0a868",
      pid: 4242,
      registerReason: "spawn",
    };
    wired.wrappedSend(incoming);

    const out = wired.sentFrames[0] as Record<string, unknown>;
    expect(out).toMatchObject({
      sessionId: "s1",
      cwd: "/path/with/fields",
      machineId: "arch-personal",
      machineLabel: "Arch",
      machineAccent: "#f0a868",
      pid: 4242,
      registerReason: "spawn",
      spawnRequestId: "req-fields",
    });
    // Input untouched.
    expect((incoming as { spawnRequestId?: string }).spawnRequestId).toBeUndefined();
  });
});
