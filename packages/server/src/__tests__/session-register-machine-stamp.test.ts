/**
 * walle-multi-machine: session_register stamps the bridge-verified
 * machineId onto the session when the inbound payload omits it, and keeps
 * a present, valid payload machineId untouched.
 *
 * The verified `connectionMachineId` is only populated for NON-loopback
 * connections — the loopback bypass in `pi-gateway-auth` forces it null.
 * These cases therefore connect via a real non-loopback IPv4 so the
 * `verifyClient` token gate runs end-to-end; they skip when the host has
 * no such interface.
 *
 * See change: walle-multi-machine.
 */
import os from "node:os";
import { EventEmitter, once } from "node:events";
import { describe, it, expect, afterEach } from "vitest";
import { WebSocket } from "ws";
import { createPiGateway, type PiGateway } from "../pi-gateway.js";
import { createMemorySessionManager } from "../memory-session-manager.js";
import { computeMachineHmac } from "../pi-gateway-auth.js";
import type { MachineEntry } from "@blackbelt-technology/pi-dashboard-shared/config.js";

const SECRET = "gateway-stamp-test-secret-AAAAAAAAAAAA";

function nonLoopbackIPv4(): string | undefined {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === "IPv4" && !ni.internal) return ni.address;
    }
  }
  return undefined;
}

function makeBearer(machineId: string, token: string): string {
  return `Bearer ${Buffer.from(JSON.stringify({ machineId, token })).toString("base64url")}`;
}

function provisionedMachine(machineId: string, label: string): MachineEntry {
  return {
    id: machineId,
    label,
    addedAt: "2026-06-01T00:00:00.000Z",
    bridgeTokenHash: computeMachineHmac(SECRET, machineId),
  };
}

let portCounter = 19720;

describe("session_register machine stamping (walle-multi-machine)", () => {
  const host = nonLoopbackIPv4();
  let gateway: PiGateway | undefined;
  let ws: WebSocket | undefined;

  afterEach(() => {
    ws?.close();
    ws = undefined;
    gateway?.stop();
    gateway = undefined;
  });

  it.skipIf(!host)(
    "stamps the bearer-verified machineId when the payload omits it",
    async () => {
      const machineId = "walle-daemon";
      const machines = [provisionedMachine(machineId, "Wall-E Daemon")];
      const sessionManager = createMemorySessionManager();
      gateway = createPiGateway(sessionManager, {
        heartbeatTimeout: 60_000,
        pingInterval: 0, // disable the WS ping timer for a clean test
        getMachines: () => machines,
        getBridgeSecret: () => SECRET,
      });
      gateway.start(portCounter++);

      // Deterministic completion signal — fired by the gateway after the
      // session_register message is fully processed. Awaited via `once`,
      // never a wall-clock delay.
      const signals = new EventEmitter();
      gateway.onSessionRegistered = (sid) => signals.emit("registered", sid);

      ws = new WebSocket(`ws://${host}:${gateway.address()}`, {
        headers: { Authorization: makeBearer(machineId, computeMachineHmac(SECRET, machineId)) },
      });
      await once(ws, "open");

      const registered = once(signals, "registered");
      // Payload omits machineId entirely → fall back to the verified id.
      ws.send(
        JSON.stringify({
          type: "session_register",
          sessionId: "stamp-1",
          cwd: "/tmp/fixture",
          source: "tui",
        }),
      );
      await registered;

      expect(sessionManager.get("stamp-1")?.machine?.id).toBe(machineId);
    },
  );

  it.skipIf(!host)(
    "keeps an explicit payload machineId over the bearer-verified id",
    async () => {
      const connId = "walle-daemon";
      const machines = [provisionedMachine(connId, "Wall-E Daemon")];
      const sessionManager = createMemorySessionManager();
      gateway = createPiGateway(sessionManager, {
        heartbeatTimeout: 60_000,
        pingInterval: 0,
        getMachines: () => machines,
        getBridgeSecret: () => SECRET,
      });
      gateway.start(portCounter++);

      const signals = new EventEmitter();
      gateway.onSessionRegistered = (sid) => signals.emit("registered", sid);

      ws = new WebSocket(`ws://${host}:${gateway.address()}`, {
        headers: { Authorization: makeBearer(connId, computeMachineHmac(SECRET, connId)) },
      });
      await once(ws, "open");

      const registered = once(signals, "registered");
      // Present, valid payload id wins; the verified id does NOT override it.
      ws.send(
        JSON.stringify({
          type: "session_register",
          sessionId: "stamp-2",
          cwd: "/tmp/fixture",
          source: "tui",
          machineId: "mac-work",
          machineLabel: "Mac Work",
        }),
      );
      await registered;

      const session = sessionManager.get("stamp-2");
      expect(session?.machine?.id).toBe("mac-work");
      expect(session?.machine?.label).toBe("Mac Work");
    },
  );
});
