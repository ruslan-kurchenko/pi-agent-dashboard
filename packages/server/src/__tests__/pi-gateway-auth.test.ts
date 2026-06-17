/**
 * walle-multi-machine: verifyBridgeUpgrade decision matrix.
 *
 * Loopback connection without auth          → accepted (bypass: loopback)
 * Non-loopback without Authorization         → 401 missing-authorization
 * Non-loopback with garbage Authorization    → 401 missing/malformed-token
 * Non-loopback with wrong token for known id → 403 token-mismatch
 * Non-loopback with correct HMAC token       → accepted, machineId attached
 * BRIDGE_SECRET unset on non-loopback        → accepted, bypass: secret-unset
 *
 * See change: walle-multi-machine.
 */
import crypto from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  computeMachineHmac,
  decodeBearerToken,
  isLoopbackAddress,
  parseBearerHeader,
  verifyBridgeUpgrade,
} from "../pi-gateway-auth.js";
import type { MachineEntry } from "@blackbelt-technology/pi-dashboard-shared/config.js";

const SECRET = "test-bridge-secret-AAAAAAAAAAAAAAAAAA";

function makeMachine(id: string, overrides: Partial<MachineEntry> = {}): MachineEntry {
  return {
    id,
    label: id,
    bridgeTokenHash: computeMachineHmac(SECRET, id),
    addedAt: "2026-06-17T00:00:00Z",
    ...overrides,
  };
}

function makeBearer(machineId: string, token: string): string {
  return `Bearer ${Buffer.from(JSON.stringify({ machineId, token })).toString("base64url")}`;
}

describe("isLoopbackAddress", () => {
  it("accepts IPv4, IPv6, and dual-stack loopback", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isLoopbackAddress(undefined)).toBe(false);
    expect(isLoopbackAddress(null)).toBe(false);
    expect(isLoopbackAddress("")).toBe(false);
    expect(isLoopbackAddress("10.0.0.1")).toBe(false);
    expect(isLoopbackAddress("100.64.0.5")).toBe(false); // Tailscale CGNAT range
    expect(isLoopbackAddress("::ffff:127.0.0.2")).toBe(false);
  });
});

describe("parseBearerHeader", () => {
  it("extracts the value from `Bearer <value>`", () => {
    expect(parseBearerHeader("Bearer abc.def")).toBe("abc.def");
    expect(parseBearerHeader("bearer abc.def")).toBe("abc.def");
    expect(parseBearerHeader("  Bearer   abc.def  ")).toBe("abc.def");
  });

  it("returns null on missing or wrong scheme", () => {
    expect(parseBearerHeader(undefined)).toBe(null);
    expect(parseBearerHeader(null)).toBe(null);
    expect(parseBearerHeader("")).toBe(null);
    expect(parseBearerHeader("Basic abc")).toBe(null);
    expect(parseBearerHeader("Bearer ")).toBe(null);
  });
});

describe("decodeBearerToken", () => {
  it("decodes a base64url JSON `{ machineId, token }`", () => {
    const encoded = Buffer.from(JSON.stringify({ machineId: "m1", token: "t1" })).toString(
      "base64url",
    );
    expect(decodeBearerToken(encoded)).toEqual({ machineId: "m1", token: "t1" });
  });

  it("returns null for invalid base64, non-JSON, wrong shape, or empty fields", () => {
    expect(decodeBearerToken("not-base64-!!!")).toBe(null);
    expect(decodeBearerToken(Buffer.from("not json").toString("base64url"))).toBe(null);
    expect(decodeBearerToken(Buffer.from(JSON.stringify([1, 2])).toString("base64url"))).toBe(
      null,
    );
    expect(
      decodeBearerToken(Buffer.from(JSON.stringify({ machineId: "m1" })).toString("base64url")),
    ).toBe(null);
    expect(
      decodeBearerToken(
        Buffer.from(JSON.stringify({ machineId: "", token: "t" })).toString("base64url"),
      ),
    ).toBe(null);
    expect(
      decodeBearerToken(
        Buffer.from(JSON.stringify({ machineId: "m1", token: "" })).toString("base64url"),
      ),
    ).toBe(null);
  });
});

describe("verifyBridgeUpgrade — loopback bypass", () => {
  it("accepts loopback IPv4 with no Authorization header", () => {
    const res = verifyBridgeUpgrade(
      { remoteAddress: "127.0.0.1", authorization: undefined },
      { machines: [], secret: SECRET },
    );
    expect(res).toEqual({ ok: true, machineId: null, bypass: "loopback" });
  });

  it("accepts loopback IPv6", () => {
    const res = verifyBridgeUpgrade(
      { remoteAddress: "::1", authorization: undefined },
      { machines: [], secret: SECRET },
    );
    expect(res.ok).toBe(true);
  });

  it("accepts loopback IPv4-mapped IPv6", () => {
    const res = verifyBridgeUpgrade(
      { remoteAddress: "::ffff:127.0.0.1", authorization: undefined },
      { machines: [], secret: SECRET },
    );
    expect(res.ok).toBe(true);
  });

  it("loopback bypass ignores a present-but-invalid Authorization", () => {
    const res = verifyBridgeUpgrade(
      { remoteAddress: "127.0.0.1", authorization: "Bearer not-a-token" },
      { machines: [], secret: SECRET },
    );
    expect(res.ok).toBe(true);
  });
});

describe("verifyBridgeUpgrade — non-loopback with gate enabled", () => {
  const REMOTE = "100.64.10.5"; // Tailscale-ish, non-loopback
  const machine = makeMachine("arch-personal");
  const validToken = computeMachineHmac(SECRET, "arch-personal");

  it("rejects 401 when Authorization is missing", () => {
    const res = verifyBridgeUpgrade(
      { remoteAddress: REMOTE, authorization: undefined },
      { machines: [machine], secret: SECRET },
    );
    expect(res).toEqual({
      ok: false,
      code: 401,
      message: "Unauthorized",
      reason: "missing-authorization",
    });
  });

  it("rejects 401 when Authorization is not a Bearer scheme", () => {
    const res = verifyBridgeUpgrade(
      { remoteAddress: REMOTE, authorization: "Basic Zm9vOmJhcg==" },
      { machines: [machine], secret: SECRET },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe(401);
    expect(res.reason).toBe("missing-authorization");
  });

  it("rejects 401 when the bearer is garbage (not decodable to {machineId, token})", () => {
    const res = verifyBridgeUpgrade(
      { remoteAddress: REMOTE, authorization: "Bearer not-base64-or-json" },
      { machines: [machine], secret: SECRET },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe(401);
    expect(res.reason).toBe("malformed-token");
  });

  it("rejects 403 when machineId is unknown to the roster", () => {
    const res = verifyBridgeUpgrade(
      { remoteAddress: REMOTE, authorization: makeBearer("unknown-machine", validToken) },
      { machines: [machine], secret: SECRET },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe(403);
    expect(res.reason).toBe("unknown-machine");
  });

  it("rejects 403 when the roster entry has no bridgeTokenHash", () => {
    const unprovisioned = makeMachine("arch-personal", { bridgeTokenHash: undefined });
    const res = verifyBridgeUpgrade(
      { remoteAddress: REMOTE, authorization: makeBearer("arch-personal", validToken) },
      { machines: [unprovisioned], secret: SECRET },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe(403);
    expect(res.reason).toBe("machine-not-provisioned");
  });

  it("rejects 403 with a wrong token for a known machineId", () => {
    const wrong = crypto.createHmac("sha256", "different-secret").update("arch-personal").digest("hex");
    const res = verifyBridgeUpgrade(
      { remoteAddress: REMOTE, authorization: makeBearer("arch-personal", wrong) },
      { machines: [machine], secret: SECRET },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe(403);
    expect(res.reason).toBe("token-mismatch");
  });

  it("rejects 403 when the stored hash drifted from the current secret (config mismatch)", () => {
    const drifted = makeMachine("arch-personal", {
      bridgeTokenHash: crypto.createHmac("sha256", "rotated-secret").update("arch-personal").digest("hex"),
    });
    const res = verifyBridgeUpgrade(
      { remoteAddress: REMOTE, authorization: makeBearer("arch-personal", validToken) },
      { machines: [drifted], secret: SECRET },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe(403);
    expect(res.reason).toBe("secret-config-mismatch");
  });

  it("accepts a valid Bearer and attaches the verified machineId", () => {
    const res = verifyBridgeUpgrade(
      { remoteAddress: REMOTE, authorization: makeBearer("arch-personal", validToken) },
      { machines: [machine], secret: SECRET },
    );
    expect(res).toEqual({ ok: true, machineId: "arch-personal", bypass: null });
  });

  it("picks the right machine from a multi-entry roster", () => {
    const m1 = makeMachine("walle-daemon");
    const m2 = makeMachine("mac-work");
    const tokenForM2 = computeMachineHmac(SECRET, "mac-work");
    const res = verifyBridgeUpgrade(
      { remoteAddress: REMOTE, authorization: makeBearer("mac-work", tokenForM2) },
      { machines: [m1, m2, machine], secret: SECRET },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.machineId).toBe("mac-work");
  });
});

describe("verifyBridgeUpgrade — secret unset (fail-open)", () => {
  const REMOTE = "100.64.10.5";

  it("accepts a non-loopback connection without Authorization and signals secret-unset bypass", () => {
    const res = verifyBridgeUpgrade(
      { remoteAddress: REMOTE, authorization: undefined },
      { machines: [], secret: undefined },
    );
    expect(res).toEqual({ ok: true, machineId: null, bypass: "secret-unset" });
  });

  it("treats empty-string secret the same as unset", () => {
    const res = verifyBridgeUpgrade(
      { remoteAddress: REMOTE, authorization: undefined },
      { machines: [], secret: "" },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.bypass).toBe("secret-unset");
  });

  it("still surfaces the bearer-claimed machineId so the caller can log it on the WARN", () => {
    const res = verifyBridgeUpgrade(
      { remoteAddress: REMOTE, authorization: makeBearer("arch-personal", "anything") },
      { machines: [], secret: undefined },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.machineId).toBe("arch-personal");
    expect(res.bypass).toBe("secret-unset");
  });

  it("does NOT validate the token when the gate is disabled", () => {
    // A bogus, unsignable bearer must still be accepted on the
    // fail-open path so day-1 installs keep working.
    const res = verifyBridgeUpgrade(
      { remoteAddress: REMOTE, authorization: "Bearer garbage" },
      { machines: [], secret: undefined },
    );
    expect(res.ok).toBe(true);
  });
});
