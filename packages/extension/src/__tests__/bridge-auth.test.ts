/**
 * walle-multi-machine: bridge-side Authorization header for the WebSocket
 * handshake. Covers both halves of the contract — the env → header
 * builder, and the WebSocket wrapper that injects the header at
 * `new WS(url)` time inside `ConnectionManager`.
 *
 * Bridge sends header when env present.
 * Bridge skips header when env absent.
 *
 * See change: walle-multi-machine.
 */
import { describe, it, expect } from "vitest";
import {
  buildBridgeAuthHeader,
  createAuthedWebSocketImpl,
  type AuthCapableCtor,
} from "../walle-bridge-auth.js";

describe("buildBridgeAuthHeader", () => {
  it("returns undefined when WALLE_MACHINE_ID is missing", () => {
    expect(
      buildBridgeAuthHeader({ WALLE_MACHINE_BRIDGE_TOKEN: "abc" }),
    ).toBeUndefined();
  });

  it("returns undefined when WALLE_MACHINE_BRIDGE_TOKEN is missing", () => {
    expect(buildBridgeAuthHeader({ WALLE_MACHINE_ID: "arch-personal" })).toBeUndefined();
  });

  it("returns undefined when env values are whitespace-only", () => {
    expect(
      buildBridgeAuthHeader({
        WALLE_MACHINE_ID: "   ",
        WALLE_MACHINE_BRIDGE_TOKEN: "abc",
      }),
    ).toBeUndefined();
    expect(
      buildBridgeAuthHeader({
        WALLE_MACHINE_ID: "arch-personal",
        WALLE_MACHINE_BRIDGE_TOKEN: "  ",
      }),
    ).toBeUndefined();
  });

  it("returns undefined for an empty env (upstream / single-machine install)", () => {
    expect(buildBridgeAuthHeader({})).toBeUndefined();
  });

  it("emits a Bearer header whose payload decodes to {machineId, token}", () => {
    const header = buildBridgeAuthHeader({
      WALLE_MACHINE_ID: "arch-personal",
      WALLE_MACHINE_BRIDGE_TOKEN: "deadbeefcafe",
    });
    expect(header).toBeDefined();
    expect(header!.Authorization.startsWith("Bearer ")).toBe(true);
    const value = header!.Authorization.slice("Bearer ".length);
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    expect(decoded).toEqual({ machineId: "arch-personal", token: "deadbeefcafe" });
  });

  it("trims surrounding whitespace from each env value before encoding", () => {
    const header = buildBridgeAuthHeader({
      WALLE_MACHINE_ID: "  arch-personal  ",
      WALLE_MACHINE_BRIDGE_TOKEN: "  deadbeef  ",
    });
    expect(header).toBeDefined();
    const value = header!.Authorization.slice("Bearer ".length);
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    expect(decoded).toEqual({ machineId: "arch-personal", token: "deadbeef" });
  });

  it("uses base64url (URL-safe, unpadded), not standard base64", () => {
    // Crafted so the underlying JSON contains characters that yield `+`,
    // `/`, or `=` in standard base64 — proves we picked base64url.
    const header = buildBridgeAuthHeader({
      WALLE_MACHINE_ID: "m??>>",
      WALLE_MACHINE_BRIDGE_TOKEN: "t<<??",
    });
    expect(header).toBeDefined();
    const value = header!.Authorization.slice("Bearer ".length);
    expect(value).not.toMatch(/[+/=]/);
  });
});

describe("createAuthedWebSocketImpl", () => {
  // Capture every `new WS(...)` invocation so we can assert the headers
  // actually flow through the wrapper to the underlying constructor.
  type Call = { url: string; protocols: string | string[] | undefined; options: { headers?: Record<string, string> } | undefined };
  function makeRecordingBase(): { Base: AuthCapableCtor; calls: Call[] } {
    const calls: Call[] = [];
    class RecordingWS {
      constructor(
        url: string,
        protocols?: string | string[],
        options?: { headers?: Record<string, string> },
      ) {
        calls.push({ url, protocols, options });
      }
    }
    return { Base: RecordingWS as unknown as AuthCapableCtor, calls };
  }

  it("forwards the url and injects the configured headers into the third arg", () => {
    const { Base, calls } = makeRecordingBase();
    const headers = { Authorization: "Bearer abc.def" };
    const Wrapped = createAuthedWebSocketImpl(Base, headers);

    new Wrapped("ws://example:9999");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("ws://example:9999");
    expect(calls[0]!.options).toEqual({ headers });
  });

  it("passes undefined for protocols so default subprotocol negotiation runs", () => {
    const { Base, calls } = makeRecordingBase();
    const Wrapped = createAuthedWebSocketImpl(Base, { Authorization: "Bearer x" });

    new Wrapped("ws://h:1");

    expect(calls[0]!.protocols).toBeUndefined();
  });

  it("creates independent instances per call (no shared state across handshakes)", () => {
    const { Base, calls } = makeRecordingBase();
    const Wrapped = createAuthedWebSocketImpl(Base, { Authorization: "Bearer y" });

    new Wrapped("ws://h:1");
    new Wrapped("ws://h:2");
    new Wrapped("ws://h:3");

    expect(calls.map((c) => c.url)).toEqual(["ws://h:1", "ws://h:2", "ws://h:3"]);
    for (const c of calls) {
      expect(c.options).toEqual({ headers: { Authorization: "Bearer y" } });
    }
  });

  it("preserves the same header object across calls (no per-call clone, no leak)", () => {
    const { Base, calls } = makeRecordingBase();
    const headers = { Authorization: "Bearer z" };
    const Wrapped = createAuthedWebSocketImpl(Base, headers);

    new Wrapped("ws://h:1");
    new Wrapped("ws://h:2");

    expect(calls[0]!.options?.headers).toBe(headers);
    expect(calls[1]!.options?.headers).toBe(headers);
  });
});

describe("end-to-end: env → header → WebSocket constructor", () => {
  it("bridge sends the header when env is present", () => {
    type Call = { url: string; options: { headers?: Record<string, string> } | undefined };
    const calls: Call[] = [];
    class RecordingWS {
      constructor(url: string, _protocols?: string | string[], options?: { headers?: Record<string, string> }) {
        calls.push({ url, options });
      }
    }

    const header = buildBridgeAuthHeader({
      WALLE_MACHINE_ID: "arch-personal",
      WALLE_MACHINE_BRIDGE_TOKEN: "feedface",
    });
    expect(header).toBeDefined();
    const Wrapped = createAuthedWebSocketImpl(
      RecordingWS as unknown as AuthCapableCtor,
      header as unknown as Record<string, string>,
    );

    new Wrapped("ws://dashboard:9999");

    expect(calls).toHaveLength(1);
    const authHeader = calls[0]!.options?.headers?.Authorization;
    expect(authHeader).toBeDefined();
    expect(authHeader!.startsWith("Bearer ")).toBe(true);
    const decoded = JSON.parse(
      Buffer.from(authHeader!.slice("Bearer ".length), "base64url").toString("utf8"),
    );
    expect(decoded).toEqual({ machineId: "arch-personal", token: "feedface" });
  });

  it("bridge skips the header when env is absent — wrapper not constructed", () => {
    // Mirrors the bridge.ts gate: when buildBridgeAuthHeader returns
    // undefined, we never call createAuthedWebSocketImpl and the
    // ConnectionManager falls back to the platform-default WebSocket
    // (no Authorization on the handshake).
    const header = buildBridgeAuthHeader({});
    expect(header).toBeUndefined();
  });
});
