/**
 * walle-multi-machine: token-gate for the pi-gateway WebSocket upgrade.
 *
 * Pure decision module — given a remote address, an Authorization header,
 * the operator-curated machine roster, and the shared bridge secret,
 * decides whether to accept the upgrade and, if so, which machineId the
 * connection belongs to.
 *
 * The actual `verifyClient` hook in `pi-gateway.ts` is a thin adapter
 * that pulls these inputs from the upgrade request and calls
 * `verifyBridgeUpgrade`.
 *
 * Loopback (127.0.0.1, ::1, ::ffff:127.0.0.1) always passes — keeps
 * single-machine and upstream installs working when no roster is configured
 * and no secret is set. Non-loopback connections require a valid HMAC token.
 *
 * Wire format of the bearer value:
 *   Authorization: Bearer <base64url(JSON.stringify({ machineId, token }))>
 *
 * `token` is `HMAC-SHA256(BRIDGE_SECRET, machineId).digest('hex')` — the same
 * value `wall-e install` writes to `machineEntry.bridgeTokenHash` when it
 * provisions the machine. The check verifies BOTH that the bearer's token
 * matches what the secret produces AND that the stored hash matches what
 * the secret produces; either mismatch is a 403.
 *
 * Fail-open with WARN when `WALLE_DASHBOARD_BRIDGE_SECRET` is unset — day-1
 * compatibility for installs that haven't been migrated yet. Caller is
 * responsible for emitting the WARN line.
 *
 * See change: walle-multi-machine.
 */
import crypto from "node:crypto";
import type { MachineEntry } from "@blackbelt-technology/pi-dashboard-shared/config.js";

/** Reason the upgrade was rejected — for logs, not for the wire. */
export type RejectReason =
  | "missing-authorization"
  | "malformed-authorization"
  | "malformed-token"
  | "unknown-machine"
  | "machine-not-provisioned"
  | "secret-config-mismatch"
  | "token-mismatch";

export type VerifyResult =
  | { ok: true; machineId: string | null; bypass: "loopback" | "secret-unset" | null }
  | { ok: false; code: number; message: string; reason: RejectReason };

export interface VerifyInput {
  remoteAddress: string | null | undefined;
  authorization: string | null | undefined;
}

export interface VerifyOptions {
  /** Operator-curated machine roster from `DashboardConfig.machines`. */
  machines: readonly MachineEntry[];
  /** `WALLE_DASHBOARD_BRIDGE_SECRET` — when unset, the gate is disabled. */
  secret: string | null | undefined;
}

/** Loopback IPs that bypass the gate — IPv4, IPv6, and dual-stack form. */
export function isLoopbackAddress(addr: string | null | undefined): boolean {
  if (!addr) return false;
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

/**
 * Parse `Authorization: Bearer <value>` into the raw value, or `null` if
 * the header is missing / not a Bearer credential.
 */
export function parseBearerHeader(authorization: string | null | undefined): string | null {
  if (typeof authorization !== "string") return null;
  const trimmed = authorization.trim();
  if (trimmed.length === 0) return null;
  const match = /^Bearer\s+(.+)$/i.exec(trimmed);
  if (!match) return null;
  const value = match[1]!.trim();
  return value.length > 0 ? value : null;
}

/**
 * Decode the bearer value (base64url JSON) into `{ machineId, token }`.
 * Returns `null` if the value is not decodable / not the expected shape.
 */
export function decodeBearerToken(
  value: string,
): { machineId: string; token: string } | null {
  let json: string;
  try {
    json = Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const machineId = obj.machineId;
  const token = obj.token;
  if (typeof machineId !== "string" || machineId.length === 0) return null;
  if (typeof token !== "string" || token.length === 0) return null;
  return { machineId, token };
}

/** Computes `HMAC-SHA256(secret, machineId).digest('hex')`. */
export function computeMachineHmac(secret: string, machineId: string): string {
  return crypto.createHmac("sha256", secret).update(machineId).digest("hex");
}

/**
 * Constant-time hex comparison. Returns `false` whenever the inputs differ
 * in length (the underlying `timingSafeEqual` throws on a length mismatch,
 * which would otherwise leak through). Both inputs must be valid hex.
 */
function constantTimeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let bufA: Buffer;
  let bufB: Buffer;
  try {
    bufA = Buffer.from(a, "hex");
    bufB = Buffer.from(b, "hex");
  } catch {
    return false;
  }
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Core gate decision. Pure — no I/O, no side effects, no logging.
 * Caller (the `verifyClient` adapter) is responsible for emitting the
 * `dashboard.security.WARN bridge-secret-unset` line on the `bypass:
 * "secret-unset"` path.
 */
export function verifyBridgeUpgrade(input: VerifyInput, opts: VerifyOptions): VerifyResult {
  if (isLoopbackAddress(input.remoteAddress)) {
    return { ok: true, machineId: null, bypass: "loopback" };
  }
  const secret = typeof opts.secret === "string" ? opts.secret : "";
  if (secret.length === 0) {
    // Fail-open: gate is disabled. Caller logs the WARN line. We still try
    // to surface the machineId from the bearer (for downstream logging /
    // pre-fill), but don't reject if it's missing or malformed.
    const bearerValue = parseBearerHeader(input.authorization);
    const decoded = bearerValue ? decodeBearerToken(bearerValue) : null;
    return {
      ok: true,
      machineId: decoded?.machineId ?? null,
      bypass: "secret-unset",
    };
  }
  const bearerValue = parseBearerHeader(input.authorization);
  if (bearerValue === null) {
    return { ok: false, code: 401, message: "Unauthorized", reason: "missing-authorization" };
  }
  const decoded = decodeBearerToken(bearerValue);
  if (decoded === null) {
    return { ok: false, code: 401, message: "Unauthorized", reason: "malformed-token" };
  }
  const entry = opts.machines.find((m) => m.id === decoded.machineId);
  if (!entry) {
    return { ok: false, code: 403, message: "Forbidden", reason: "unknown-machine" };
  }
  if (typeof entry.bridgeTokenHash !== "string" || entry.bridgeTokenHash.length === 0) {
    return { ok: false, code: 403, message: "Forbidden", reason: "machine-not-provisioned" };
  }
  const expected = computeMachineHmac(secret, decoded.machineId);
  // The expected HMAC must match BOTH the bearer's token AND the stored
  // hash. A mismatch on the stored side means the secret rotated without
  // re-provisioning that machine — treat as a config error (403).
  if (!constantTimeHexEqual(expected, entry.bridgeTokenHash)) {
    return { ok: false, code: 403, message: "Forbidden", reason: "secret-config-mismatch" };
  }
  if (!constantTimeHexEqual(expected, decoded.token)) {
    return { ok: false, code: 403, message: "Forbidden", reason: "token-mismatch" };
  }
  return { ok: true, machineId: decoded.machineId, bypass: null };
}
