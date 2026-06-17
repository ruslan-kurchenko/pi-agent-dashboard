/**
 * Pi Gateway - WebSocket server for bridge extension connections.
 */
import { WebSocketServer, WebSocket } from "ws";
import type { ExtensionToServerMessage, ServerToExtensionMessage } from "@blackbelt-technology/pi-dashboard-shared/protocol.js";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import type { MachineEntry } from "@blackbelt-technology/pi-dashboard-shared/config.js";
import type { SessionManager } from "./memory-session-manager.js";
import { getSpawnRegisterWatchdog } from "./spawn-register-watchdog.js";
import { verifyBridgeUpgrade, type RejectReason } from "./pi-gateway-auth.js";

export const HEARTBEAT_TIMEOUT = 180_000;
export const WS_PING_INTERVAL = 60_000;

export interface PiGatewayOptions {
  heartbeatTimeout?: number;
  pingInterval?: number;
  /**
   * walle-multi-machine: source-of-truth for the operator-curated machine
   * roster used by the non-loopback `verifyClient` token gate. Called once
   * per upgrade so it stays cheap to re-read config on each connect.
   * Returns `[]` (the default) for upstream installs that keep
   * loopback-only behaviour.
   */
  getMachines?: () => readonly MachineEntry[];
  /**
   * walle-multi-machine: shared bridge HMAC secret. When `undefined` /
   * empty, the gate fails open and emits `dashboard.security.WARN
   * bridge-secret-unset` on every non-loopback connection so unmigrated
   * installs keep working but the operator notices. Defaults to reading
   * `WALLE_DASHBOARD_BRIDGE_SECRET` from `process.env`.
   */
  getBridgeSecret?: () => string | undefined;
}

export interface PiGateway {
  start(port: number): void;
  stop(): void;
  /** Resolved listening port after start() (useful when start(0) is used). Returns null if not started or closed. */
  address(): number | null;
  sendToSession(sessionId: string, msg: ServerToExtensionMessage): boolean;
  broadcast(msg: ServerToExtensionMessage): void;
  connectionCount(): number;
  findSessionByCwd(cwd: string): string | undefined;
  getConnectedSessionIds(): string[];
  isSessionConnected(sessionId: string): boolean;
  /** Force-close the WebSocket connection for a session */
  closeSession(sessionId: string): boolean;
  /**
   * walle-multi-machine: look up the WebSocket of the bridge whose
   * authenticated `machineId` matches `id`. Returns the most recently
   * registered bridge (LIFO) when multiple connections share the same
   * id — e.g. operator's laptop reconnected, so the freshest one wins.
   * Returns `undefined` when no bridge for that id is currently
   * connected, OR when the only matching connection is a loopback
   * bypass with no machineId on the auth context.
   * See change: walle-multi-machine.
   */
  findBridgeByMachineId(id: string): WebSocket | undefined;
  onEvent?: (sessionId: string, msg: ExtensionToServerMessage) => void;
  onEmpty?: () => void;
  onConnection?: () => void;
  onDisconnect?: (sessionId: string) => void;
  onSessionCreated?: (sessionId: string) => void;
  /**
   * Fired after a `session_register` message has been processed and the
   * session is in the manager. Receives the registered sessionId and its
   * cwd. Wired by the dashboard server to consume any pending
   * spawn-with-attach intent. See change:
   * add-folder-task-checker-and-spawn-attach.
   */
  onSessionRegistered?: (sessionId: string, cwd: string) => void;
}

/**
 * walle-multi-machine: small registry tracking live bridge WebSockets by
 * their bearer-authenticated `machineId`. Used by `createPiGateway` to
 * resolve cross-machine spawn frames to the right bridge connection.
 *
 * - `register`: push the ws onto the machineId's LIFO stack.
 * - `unregister`: drop the ws from the machineId's stack; the stack is
 *   deleted when it empties.
 * - `find`: return the most recently registered ws that is still in
 *   `OPEN` readyState — so a freshly-reconnected laptop preempts an
 *   older socket whose `close` event has not yet fired. Falls back to
 *   the raw top-of-stack when nothing is OPEN so the caller can still
 *   surface a typed `MACHINE_OFFLINE` error after `send` rejects.
 * - `clear`: drop every entry (used on `stop()`).
 *
 * No-ops are tolerated (empty machineId, ws not in the stack) so the
 * caller can defensively call register/unregister without pre-checks.
 */
export interface BridgeRegistry {
  register(machineId: string, ws: WebSocket): void;
  unregister(machineId: string, ws: WebSocket): void;
  find(machineId: string): WebSocket | undefined;
  clear(): void;
}

export function createBridgeRegistry(): BridgeRegistry {
  const stacks = new Map<string, WebSocket[]>();
  return {
    register(machineId, ws) {
      if (typeof machineId !== "string" || machineId.length === 0) return;
      const stack = stacks.get(machineId);
      if (stack) stack.push(ws);
      else stacks.set(machineId, [ws]);
    },
    unregister(machineId, ws) {
      if (typeof machineId !== "string" || machineId.length === 0) return;
      const stack = stacks.get(machineId);
      if (!stack) return;
      const idx = stack.lastIndexOf(ws);
      if (idx >= 0) stack.splice(idx, 1);
      if (stack.length === 0) stacks.delete(machineId);
    },
    find(machineId) {
      if (typeof machineId !== "string" || machineId.length === 0) return undefined;
      const stack = stacks.get(machineId);
      if (!stack || stack.length === 0) return undefined;
      for (let i = stack.length - 1; i >= 0; i--) {
        const ws = stack[i]!;
        if (ws.readyState === WebSocket.OPEN) return ws;
      }
      return stack[stack.length - 1];
    },
    clear() {
      stacks.clear();
    },
  };
}

export function createPiGateway(
  sessionManager: SessionManager,
  options?: PiGatewayOptions,
): PiGateway {
  const hbTimeout = options?.heartbeatTimeout ?? HEARTBEAT_TIMEOUT;
  const pingMs = options?.pingInterval ?? WS_PING_INTERVAL;
  let wss: WebSocketServer | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;

  // Map sessionId → WebSocket
  const connections = new Map<string, WebSocket>();
  // Track connection liveness for WS ping/pong (miss counter: kill after 2 consecutive misses)
  const aliveMisses = new Map<WebSocket, number>();
  // Map sessionId → heartbeat timeout
  const heartbeatTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Map sessionId → { setAt: timestamp, sleepRetried: boolean } for sleep detection
  const heartbeatMeta = new Map<string, { setAt: number; sleepRetried: boolean }>();
  // walle-multi-machine: bearer-authenticated `machineId` → live bridge
  // WebSocket registry. See `createBridgeRegistry` for ordering rules
  // (LIFO, OPEN-preferred). Loopback connections come in with
  // `connectionMachineId === null` and stay out of the registry — the
  // routing path returns undefined for those by construction.
  const bridgeRegistry = createBridgeRegistry();

  let onEvent: ((sessionId: string, msg: ExtensionToServerMessage) => void) | undefined;
  let onEmpty: (() => void) | undefined;
  let onConnection: (() => void) | undefined;
  let onDisconnect: ((sessionId: string) => void) | undefined;
  let onSessionCreated: ((sessionId: string) => void) | undefined;
  let onSessionRegistered: ((sessionId: string, cwd: string) => void) | undefined;

  function checkEmpty() {
    if (connections.size === 0) {
      onEmpty?.();
    }
  }

  function resetHeartbeat(sessionId: string) {
    const existing = heartbeatTimers.get(sessionId);
    if (existing) clearTimeout(existing);

    const now = Date.now();
    heartbeatMeta.set(sessionId, { setAt: now, sleepRetried: false });

    heartbeatTimers.set(
      sessionId,
      setTimeout(() => {
        // If the WebSocket TCP connection is still open, don't kill the session.
        // The bridge is just busy (e.g. running a long tool execution) and can't
        // send heartbeats, but the connection itself is alive. Reschedule.
        const ws = connections.get(sessionId);
        if (ws && ws.readyState === WebSocket.OPEN) {
          console.error(`[gateway] heartbeat timeout but WS still OPEN for ${sessionId}, rescheduling`);
          resetHeartbeat(sessionId);
          return;
        }
        // Session status check: if the session is still streaming/active
        // (not manually ended), give it more time to reconnect.
        // Forked child processes (vitest) can kill the WS connection by
        // inheriting and closing the FD, but the bridge will reconnect
        // once the event loop is free.
        const session = sessionManager.get(sessionId);
        const meta = heartbeatMeta.get(sessionId);
        if (session && session.status !== "ended" && !meta?.sleepRetried) {
          console.error(`[gateway] heartbeat timeout but session ${sessionId} still active, giving reconnect grace period`);
          if (meta) {
            meta.sleepRetried = true;
            meta.setAt = Date.now();
          }
          heartbeatTimers.set(
            sessionId,
            setTimeout(() => {
              const ws2 = connections.get(sessionId);
              if (ws2 && ws2.readyState === WebSocket.OPEN) {
                resetHeartbeat(sessionId);
                return;
              }
              console.error(`[gateway] session timed out: ${sessionId} (reconnect grace period expired)`);
              sessionManager.unregister(sessionId);
              connections.delete(sessionId);
              heartbeatTimers.delete(sessionId);
              heartbeatMeta.delete(sessionId);
              checkEmpty();
            }, hbTimeout),
          );
          return;
        }
        console.error(`[gateway] heartbeat timeout, WS state=${ws?.readyState} for ${sessionId}`);

        const meta2 = heartbeatMeta.get(sessionId);
        const elapsed = Date.now() - (meta2?.setAt ?? now);

        // Detect sleep: elapsed >> expected means system was suspended
        if (meta2 && !meta2.sleepRetried && elapsed > hbTimeout * 2) {
          // Give one more cycle for the extension to reconnect
          meta2.sleepRetried = true;
          meta2.setAt = Date.now();
          heartbeatTimers.set(
            sessionId,
            setTimeout(() => {
              const ws2 = connections.get(sessionId);
              if (ws2 && ws2.readyState === WebSocket.OPEN) {
                resetHeartbeat(sessionId);
                return;
              }
              console.error(`[gateway] session timed out: ${sessionId} (sleep recovery failed)`);
              sessionManager.unregister(sessionId);
              connections.delete(sessionId);
              heartbeatTimers.delete(sessionId);
              heartbeatMeta.delete(sessionId);
              checkEmpty();
            }, hbTimeout),
          );
          return;
        }

        console.error(`[gateway] session timed out: ${sessionId} (no heartbeat for ${hbTimeout}ms)`);
        sessionManager.unregister(sessionId);
        connections.delete(sessionId);
        heartbeatTimers.delete(sessionId);
        heartbeatMeta.delete(sessionId);
        checkEmpty();
      }, hbTimeout)
    );
  }

  return {
    set onEvent(handler: ((sessionId: string, msg: ExtensionToServerMessage) => void) | undefined) {
      onEvent = handler;
    },

    set onEmpty(handler: (() => void) | undefined) {
      onEmpty = handler;
    },

    set onConnection(handler: (() => void) | undefined) {
      onConnection = handler;
    },

    set onDisconnect(handler: ((sessionId: string) => void) | undefined) {
      onDisconnect = handler;
    },

    set onSessionCreated(handler: ((sessionId: string) => void) | undefined) {
      onSessionCreated = handler;
    },

    set onSessionRegistered(handler: ((sessionId: string, cwd: string) => void) | undefined) {
      onSessionRegistered = handler;
    },

    address() {
      const addr = wss?.address();
      if (addr && typeof addr === "object") return addr.port;
      return null;
    },
    start(port: number) {
      // walle-multi-machine: token gate on the upgrade. Loopback always
      // passes; non-loopback requires a Bearer token whose HMAC matches
      // the operator-curated roster. Fail-open with WARN when
      // `WALLE_DASHBOARD_BRIDGE_SECRET` is unset.
      const getMachines = options?.getMachines;
      const getBridgeSecret =
        options?.getBridgeSecret ?? (() => process.env.WALLE_DASHBOARD_BRIDGE_SECRET);
      // Stamps the upgrade `IncomingMessage` with the verified machineId so
      // the `connection` handler can read it without re-parsing the bearer.
      wss = new WebSocketServer({
        port,
        verifyClient: (info, cb) => {
          const remoteAddress = info.req.socket.remoteAddress;
          const result = verifyBridgeUpgrade(
            { remoteAddress, authorization: info.req.headers.authorization },
            {
              machines: getMachines?.() ?? [],
              secret: getBridgeSecret(),
            },
          );
          if (!result.ok) {
            const reason: RejectReason = result.reason;
            console.error(
              `[gateway] reject upgrade from ${remoteAddress ?? "?"}: ${result.code} ${result.message} (${reason})`,
            );
            cb(false, result.code, result.message);
            return;
          }
          if (result.bypass === "secret-unset") {
            console.error(
              `dashboard.security.WARN bridge-secret-unset remote=${remoteAddress ?? "?"} machineId=${result.machineId ?? "?"} — set WALLE_DASHBOARD_BRIDGE_SECRET to enforce gate`,
            );
          }
          (info.req as unknown as { walleMachineId?: string | null }).walleMachineId =
            result.machineId;
          cb(true);
        },
      });

      // WS-level ping/pong: detect truly dead connections.
      // Pong responses are processed in the event loop, so a busy bridge
      // won't respond to pings. We check the underlying TCP socket's
      // writable state as a fallback — if TCP is alive, the bridge is just
      // busy, not dead.
      const PING_MISS_THRESHOLD = 3;
      if (pingMs > 0) pingTimer = setInterval(() => {
        if (!wss) return;
        for (const client of wss.clients) {
          const misses = aliveMisses.get(client) ?? 0;
          if (misses >= PING_MISS_THRESHOLD) {
            // Check if the underlying TCP socket is still alive.
            // If the socket is writable, the connection is physically intact —
            // the bridge is just too busy to process pong frames.
            const socket = (client as any)._socket;
            const socketAlive = socket && !socket.destroyed && socket.writable;
            if (socketAlive) {
              // TCP alive but no pong — bridge is busy. Reset counter, keep alive.
              console.error(`[gateway] ping: ${misses} misses but TCP alive, keeping session (socket.destroyed=${socket?.destroyed} writable=${socket?.writable})`);
              aliveMisses.set(client, 0);
              client.ping();
              continue;
            }
            // TCP is dead — clean up
            console.error(`[gateway] ping: TCP dead (socket=${!!socket} destroyed=${socket?.destroyed} writable=${socket?.writable})`);
            
            for (const [sid, ws] of connections) {
              if (ws === client) {
                console.error(`[gateway] connection dead (ping timeout, ${misses} misses): ${sid}`);
                sessionManager.unregister(sid);
                connections.delete(sid);
                const timer = heartbeatTimers.get(sid);
                if (timer) clearTimeout(timer);
                heartbeatTimers.delete(sid);
                heartbeatMeta.delete(sid);
                break;
              }
            }
            client.terminate();
            aliveMisses.delete(client);
            checkEmpty();
            continue;
          }
          aliveMisses.set(client, misses + 1);
          client.ping();
        }
      }, pingMs);

      wss.on("connection", (ws, req) => {
        // walle-multi-machine: pre-filled by `verifyClient`. Null on the
        // loopback bypass or when the gate is fail-open without a bearer;
        // string when the bearer authenticated. Surfaced in the
        // `session registered` log so non-loopback connections show which
        // operator-roster entry the bridge claims to be.
        const connectionMachineId =
          (req as unknown as { walleMachineId?: string | null }).walleMachineId ?? null;
        let currentSessionId: string | null = null;
        aliveMisses.set(ws, 0);
        ws.on("pong", () => { aliveMisses.set(ws, 0); });

        // walle-multi-machine: register this ws under its authenticated
        // machineId so `findBridgeByMachineId` can route cross-machine
        // spawn frames. Loopback connections come through with
        // `connectionMachineId === null` and the registry no-ops on them.
        if (connectionMachineId) {
          bridgeRegistry.register(connectionMachineId, ws);
        }

        ws.on("message", (raw) => {
          // Any received message proves the connection is alive
          aliveMisses.set(ws, 0);
          try {
            const msg = JSON.parse(raw.toString()) as ExtensionToServerMessage;

            // Track session identity from any message with a sessionId
            if (!currentSessionId && "sessionId" in msg && (msg as any).sessionId) {
              const sid: string = (msg as any).sessionId;
              currentSessionId = sid;
              connections.set(sid, ws);
              // Auto-create a placeholder session so events aren't lost
              if (!sessionManager.get(sid)) {
                sessionManager.register({
                  id: sid,
                  cwd: "",
                  source: "unknown",
                });
                onSessionCreated?.(sid);
              }
              resetHeartbeat(sid);
              onConnection?.();
            }

            if (msg.type === "session_register") {
              // Clear spawn-register watchdog BEFORE any throwing logic. See change: spawn-failure-diagnostics.
              // Priority: token > pid > cwd. Token is the strongest identity
              // (spawn-correlation-token); pid catches headless without token;
              // cwd is the legacy fallback for tmux/wt with neither.
              const watchdog = getSpawnRegisterWatchdog();
              if (msg.spawnToken) watchdog.clearByToken(msg.spawnToken);
              if (msg.pid !== undefined) watchdog.clearByPid(msg.pid);
              watchdog.clearByCwd(msg.cwd);

              // If session ID changed (e.g., after /reload), clean up the old placeholder
              if (currentSessionId && currentSessionId !== msg.sessionId) {
                const oldSession = sessionManager.get(currentSessionId);
                // Clean up if it's an auto-created placeholder (source unknown)
                // or a ghost session (no sessionFile, created by duplicate bridge)
                if (oldSession && (oldSession.source === "unknown" || !oldSession.sessionFile)) {
                  sessionManager.unregister(currentSessionId);
                  connections.delete(currentSessionId);
                }
              }
              currentSessionId = msg.sessionId;
              connections.set(msg.sessionId, ws);

              sessionManager.register({
                id: msg.sessionId,
                cwd: msg.cwd,
                name: msg.name,
                source: msg.source,
                model: msg.model,
                thinkingLevel: msg.thinkingLevel,
                sessionFile: msg.sessionFile,
                sessionDir: msg.sessionDir,
                firstMessage: msg.firstMessage,
                pid: msg.pid,
                // Forward registerReason so server.ts onChange can apply
                // the configured reattach placement policy.
                // See change: reattach-move-to-front.
                registerReason: msg.registerReason,
                // Fact-forwarding for the first-register auto-hide heuristic.
                // Normalize untrusted socket inputs to known types before
                // forwarding so a malformed payload cannot skew visibility.
                // See change: auto-hide-headless-worker-sessions.
                hasUI: typeof msg.hasUI === "boolean" ? msg.hasUI : undefined,
                visibilityIntent:
                  msg.visibilityIntent === "hidden" || msg.visibilityIntent === "visible"
                    ? msg.visibilityIntent
                    : undefined,
                // Per-machine identity (walle multi-machine). Sanitize: only
                // accept `machineId` as a non-empty string; the others are
                // optional and decorative. See change: walle-multi-machine.
                machine:
                  typeof msg.machineId === "string" && msg.machineId.trim().length > 0
                    ? {
                        id: msg.machineId,
                        label:
                          typeof msg.machineLabel === "string" ? msg.machineLabel : undefined,
                        accent:
                          typeof msg.machineAccent === "string" ? msg.machineAccent : undefined,
                      }
                    : // walle-multi-machine: fall back to bearer-verified machineId when payload omits it
                      connectionMachineId
                      ? {
                          id: connectionMachineId,
                          label:
                            typeof msg.machineLabel === "string" ? msg.machineLabel : undefined,
                          accent:
                            typeof msg.machineAccent === "string" ? msg.machineAccent : undefined,
                        }
                      : undefined,
              });
              console.error(
                `[gateway] session registered: ${msg.sessionId} cwd=${msg.cwd}${connectionMachineId ? ` machineId=${connectionMachineId}` : ""}`,
              );

              resetHeartbeat(msg.sessionId);
              onConnection?.();
              onSessionRegistered?.(msg.sessionId, msg.cwd);
            }

            if (msg.type === "session_heartbeat" && msg.sessionId) {
              resetHeartbeat(msg.sessionId);
              // Store process metrics on the session if provided
              if (msg.metrics) {
                sessionManager.update(msg.sessionId, {
                  processMetrics: { ...msg.metrics, updatedAt: Date.now() },
                });
              }
              // Respond with ack so the bridge can track server liveness
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "heartbeat_ack" }));
              }
            }

            if (msg.type === "session_unregister" && msg.sessionId) {
              console.error(`[gateway] session unregistered: ${msg.sessionId} (explicit)`);
              sessionManager.unregister(msg.sessionId);
              connections.delete(msg.sessionId);
              const timer = heartbeatTimers.get(msg.sessionId);
              if (timer) {
                clearTimeout(timer);
                heartbeatTimers.delete(msg.sessionId);
              }
              heartbeatMeta.delete(msg.sessionId);
              checkEmpty();
            }

            if (msg.type === "model_update") {
              const session = sessionManager.get(msg.sessionId);
              if (session) {
                const updates: Partial<typeof session> = { model: msg.model };
                if (msg.thinkingLevel !== undefined) {
                  updates.thinkingLevel = msg.thinkingLevel;
                }
                sessionManager.update(msg.sessionId, updates);
              }
            }

            // Notify listeners
            const eventSessionId = "sessionId" in msg ? (msg as any).sessionId : undefined;
            onEvent?.(eventSessionId ?? currentSessionId ?? "", msg);
          } catch {
            // Ignore malformed messages
          }
        });

        ws.on("close", () => {
          if (currentSessionId) {
            console.error(`[gateway] connection closed: ${currentSessionId}`);
            // Don't immediately unregister - wait for heartbeat timeout
            // This handles temporary disconnects
            onDisconnect?.(currentSessionId);
          }
          aliveMisses.delete(ws);
          // walle-multi-machine: drop this ws from the bridge registry.
          // We do NOT wait for heartbeat timeout — a closed TCP socket
          // is dead for routing purposes even if the session-side
          // cleanup grants a reconnect grace window.
          if (connectionMachineId) {
            bridgeRegistry.unregister(connectionMachineId, ws);
          }
        });
      });
    },

    stop() {
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
      for (const timer of heartbeatTimers.values()) {
        clearTimeout(timer);
      }
      heartbeatTimers.clear();
      heartbeatMeta.clear();
      aliveMisses.clear();
      // Forcibly terminate all extension connections
      for (const ws of connections.values()) {
        ws.terminate();
      }
      connections.clear();
      bridgeRegistry.clear();
      wss?.close();
      wss = null;
    },

    sendToSession(sessionId: string, msg: ServerToExtensionMessage): boolean {
      const ws = connections.get(sessionId);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
        return true;
      }
      return false;
    },

    broadcast(msg: ServerToExtensionMessage): void {
      const payload = JSON.stringify(msg);
      for (const ws of connections.values()) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(payload);
        }
      }
    },

    connectionCount(): number {
      return connections.size;
    },

    isSessionConnected(sessionId: string): boolean {
      const ws = connections.get(sessionId);
      return ws !== undefined && ws.readyState === WebSocket.OPEN;
    },

    findSessionByCwd(cwd: string): string | undefined {
      // Find a connected session whose cwd matches or is a prefix
      for (const sid of connections.keys()) {
        const session = sessionManager.get(sid);
        if (session && (session.cwd === cwd || session.cwd.startsWith(cwd + "/") || cwd.startsWith(session.cwd + "/"))) {
          return sid;
        }
      }
      return undefined;
    },

    getConnectedSessionIds(): string[] {
      return [...connections.keys()].filter(
        (sid) => connections.get(sid)?.readyState === WebSocket.OPEN,
      );
    },

    closeSession(sessionId: string): boolean {
      const ws = connections.get(sessionId);
      if (ws) {
        ws.close();
        connections.delete(sessionId);
        return true;
      }
      return false;
    },

    findBridgeByMachineId(id: string): WebSocket | undefined {
      return bridgeRegistry.find(id);
    },
  };
}
