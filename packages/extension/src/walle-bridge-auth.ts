/**
 * walle multi-machine: build the `Authorization: Bearer …` header the
 * extension bridge sends with its WebSocket handshake to the dashboard
 * `pi-gateway`.
 *
 * The bearer value is `base64url(JSON.stringify({ machineId, token }))`.
 * `token` is the plaintext HMAC issued by `wall-e install` and persisted
 * to `~/.wall-e/<profile>/machine.json` (mode 0600); the server checks it
 * against `HMAC-SHA256(WALLE_DASHBOARD_BRIDGE_SECRET, machineId)` in
 * `packages/server/src/pi-gateway-auth.ts`.
 *
 * Env contract (both must be set to emit the header):
 *
 *   WALLE_MACHINE_ID            — operator-assigned slug, e.g. `arch-personal`
 *   WALLE_MACHINE_BRIDGE_TOKEN  — hex HMAC, written by `wall-e install`
 *
 * Either unset → returns `undefined` and the bridge falls back to the
 * unauthenticated handshake (loopback installs, upstream BlackBelt
 * installs without wall-e). Empty/whitespace-only values are treated as
 * unset.
 *
 * Pure function — no I/O, no env mutation. Tested in
 * `__tests__/bridge-auth.test.ts`.
 *
 * See change: walle-multi-machine.
 */
/** Single-key shape for the `Authorization` header the bridge attaches
 *  to the WebSocket handshake. Carries an index signature so it's
 *  structurally compatible with `Record<string, string>` (the shape
 *  `ws.ClientOptions.headers` expects). */
export interface BridgeAuthHeader {
  Authorization: string;
  [header: string]: string;
}

export function buildBridgeAuthHeader(
  env: NodeJS.ProcessEnv,
): BridgeAuthHeader | undefined {
  const machineId = (env.WALLE_MACHINE_ID ?? "").trim();
  const token = (env.WALLE_MACHINE_BRIDGE_TOKEN ?? "").trim();
  if (!machineId || !token) return undefined;
  const value = Buffer.from(JSON.stringify({ machineId, token })).toString("base64url");
  return { Authorization: `Bearer ${value}` };
}

/**
 * Wrap a Node `ws`-style WebSocket constructor so every instantiation
 * carries the given headers on the upgrade handshake. The wrapper accepts
 * the same `(url)` signature `ConnectionManager` already calls — keeping
 * the manager generic and untouched.
 *
 * Browser-style `globalThis.WebSocket` does NOT support custom headers,
 * so the caller MUST pass a Node `ws` package WebSocket here when an auth
 * header is needed.
 */
export type WebSocketCtor = new (url: string) => object;
export type AuthCapableCtor = new (
  url: string,
  protocols?: string | string[],
  options?: { headers?: Record<string, string> },
) => object;

export function createAuthedWebSocketImpl(
  Base: AuthCapableCtor,
  headers: Record<string, string>,
): WebSocketCtor {
  // Subclass so the returned constructor still produces a real
  // `ws` WebSocket — preserves readyState constants, event emitter
  // surface, and anything else `ConnectionManager` (which only sees
  // browser-style `onopen`/`onmessage`/`onclose`/`onerror`) might
  // touch in the future. `extends (X)` requires a statically-known
  // object instance type, hence the cast.
  return class AuthedWebSocket extends (Base as unknown as new (
    ...args: unknown[]
  ) => object) {
    constructor(url: string) {
      super(url, undefined, { headers });
    }
  } as unknown as WebSocketCtor;
}
