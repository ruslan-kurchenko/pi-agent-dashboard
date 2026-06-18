/**
 * walle-multi-machine: bridge-side handler for `spawn_on_machine` frames.
 *
 * The dashboard server emits one of these frames over the same WebSocket
 * the bridge already dialed at startup whenever the operator clicks a
 * cross-machine spawn whose target `machineId` matches THIS bridge.
 *
 * Responsibilities:
 *
 *   1. Invoke the local agent at `cwd` (via the injected `invokeLocalAgent`
 *      callback — `bridge.ts` wires this to a detached `omp`/`pi` spawn,
 *      same way `scripts/wall-e/run.ts` would).
 *   2. Track the pending request keyed by `cwd` so the very first
 *      `session_register` the spawned agent emits can be tagged with the
 *      originating `spawnRequestId`. The dashboard then correlates the
 *      browser's `spawn_session` click with the newly registered session.
 *   3. Time the entry out after {@link SPAWN_REGISTER_TIMEOUT_MS} and emit
 *      a `spawn_on_machine_failed` frame upstream so the dashboard can
 *      surface the failure instead of leaving a silent ghost spawn.
 *
 * Pure module — every side effect (shelling out, WebSocket send,
 * clock) is injected through `SpawnOnMachineContext`. That makes the
 * unit tests in `__tests__/spawn-on-machine-handler.test.ts` exhaustive
 * without mocking timers, files, or sockets.
 *
 * Same cwd twice → second overwrites the first; the first is treated as
 * timed out (i.e. emits `AGENT_DIDNT_REGISTER` immediately) so the
 * dashboard never sees a dangling requestId. First wins is wrong for
 * cross-machine spawn because the second click usually means the user
 * gave up on the first; matching the second register to the first
 * requestId would put the new session on the OLD card.
 *
 * See change: walle-multi-machine.
 */
import type {
  SessionRegisterMessage,
  SpawnOnMachineExtensionMessage,
  SpawnOnMachineFailedToServerMessage,
} from "@blackbelt-technology/pi-dashboard-shared/protocol.js";

/**
 * How long the bridge waits for the spawned agent's first
 * `session_register` before declaring the spawn dead. Mirrors the server's
 * existing local-spawn watchdog window.
 */
export const SPAWN_REGISTER_TIMEOUT_MS = 30_000;

export interface PendingSpawn {
  requestId: string;
  cwd: string;
  attachProposal?: string;
  gitWorktreeBase?: string;
  expiresAt: number;
}

export interface SpawnOnMachineContext {
  /** Sends a message to the upstream dashboard. */
  sendUpstream: (msg: unknown) => void;
  /** Invokes the local agent. Provider-specific (omp / pi). */
  invokeLocalAgent: (
    cwd: string,
    opts: {
      attachProposal?: string;
      gitWorktreeBase?: string;
      prompt?: string;
      model?: string;
      thinkingLevel?: string;
    },
  ) => Promise<void>;
  /** Stable monotonic clock for tests. Production passes `Date.now`. */
  now: () => number;
  /**
   * Optional structured logger. Defaults to console.warn / console.error.
   * Tests inject a capture array so warnings/errors don't leak to stderr.
   */
  logger?: { warn: (msg: string) => void; error: (msg: string) => void };
}

export interface SpawnOnMachineHandler {
  /**
   * Process an inbound `spawn_on_machine` frame: invoke the local agent
   * and remember the pending spawn so the next register can be tagged.
   */
  handle(msg: SpawnOnMachineExtensionMessage): Promise<void>;
  /**
   * Inspect every outbound `session_register`. When a register's `cwd`
   * matches a pending entry, tag the message with `spawnRequestId` and
   * clear the entry; otherwise return it unchanged. Non-matching
   * registers (the bridge's own initial register, reattach, etc.) are
   * passed through verbatim so this hook is safe to install once at
   * the connection's `send` boundary.
   */
  onSessionRegister(msg: SessionRegisterMessage): SessionRegisterMessage;
  /**
   * Expire any pending entry whose `expiresAt` is in the past, emitting
   * a `spawn_on_machine_failed` frame upstream for each. The bridge
   * drives this on a periodic timer; tests call it manually after
   * advancing the injected clock.
   */
  tickTimeouts(): void;
  /** Test-only: read-only snapshot of the pending map. */
  _peekPending(): ReadonlyMap<string, PendingSpawn>;
}

export function createSpawnOnMachineHandler(
  ctx: SpawnOnMachineContext,
): SpawnOnMachineHandler {
  const pending = new Map<string, PendingSpawn>();
  const log = ctx.logger ?? {
    warn: (m: string) => console.warn(m),
    error: (m: string) => console.error(m),
  };

  function emitFailure(
    entry: PendingSpawn,
    code: SpawnOnMachineFailedToServerMessage["code"],
    message: string,
  ): void {
    const out: SpawnOnMachineFailedToServerMessage = {
      type: "spawn_on_machine_failed",
      requestId: entry.requestId,
      cwd: entry.cwd,
      code,
      message,
    };
    ctx.sendUpstream(out);
  }

  return {
    async handle(msg) {
      const existing = pending.get(msg.cwd);
      if (existing) {
        // Second overwrites the first; the first is treated as timed out
        // so the dashboard never leaves a requestId dangling. We do this
        // BEFORE registering the new entry so the emitted failure carries
        // the old requestId, not the new one.
        log.warn(
          `[dashboard] spawn_on_machine: collision on cwd=${msg.cwd}; ` +
            `superseding pending requestId=${existing.requestId} with ${msg.requestId} ` +
            `(first treated as AGENT_DIDNT_REGISTER)`,
        );
        emitFailure(
          existing,
          "AGENT_DIDNT_REGISTER",
          `Superseded by a newer spawn_on_machine for the same cwd before the agent could register.`,
        );
      }
      const entry: PendingSpawn = {
        requestId: msg.requestId,
        cwd: msg.cwd,
        attachProposal: msg.attachProposal,
        gitWorktreeBase: msg.gitWorktreeBase,
        expiresAt: ctx.now() + SPAWN_REGISTER_TIMEOUT_MS,
      };
      pending.set(msg.cwd, entry);

      try {
        await ctx.invokeLocalAgent(msg.cwd, {
          attachProposal: msg.attachProposal,
          gitWorktreeBase: msg.gitWorktreeBase,
          prompt: msg.prompt,
          model: msg.model,
          thinkingLevel: msg.thinkingLevel,
        });
      } catch (err) {
        // invokeLocalAgent threw outright — the child won't come, so drop
        // the entry now and report instead of waiting 30 s. Guard against
        // a same-cwd supersede that already replaced our entry: only drop
        // if our requestId is still the one in the map.
        const current = pending.get(msg.cwd);
        if (current && current.requestId === msg.requestId) {
          pending.delete(msg.cwd);
        }
        const detail = err instanceof Error ? err.message : String(err);
        log.error(
          `[dashboard] spawn_on_machine: invokeLocalAgent threw for cwd=${msg.cwd} requestId=${msg.requestId}: ${detail}`,
        );
        emitFailure(entry, "AGENT_INVOKE_FAILED", detail);
      }
    },

    onSessionRegister(msg) {
      const entry = pending.get(msg.cwd);
      if (!entry) return msg;
      pending.delete(msg.cwd);
      return { ...msg, spawnRequestId: entry.requestId };
    },

    tickTimeouts() {
      const t = ctx.now();
      // Collect first to avoid emitting under the iterator (sendUpstream
      // is host-supplied; we don't trust it to be sync-clean).
      const expired: PendingSpawn[] = [];
      for (const [cwd, entry] of pending) {
        if (t < entry.expiresAt) continue;
        expired.push(entry);
        pending.delete(cwd);
      }
      for (const entry of expired) {
        emitFailure(
          entry,
          "AGENT_DIDNT_REGISTER",
          `Local agent did not send session_register within ${SPAWN_REGISTER_TIMEOUT_MS}ms ` +
            `after spawn_on_machine(cwd=${entry.cwd}, requestId=${entry.requestId}).`,
        );
      }
    },

    _peekPending() {
      return pending;
    },
  };
}
