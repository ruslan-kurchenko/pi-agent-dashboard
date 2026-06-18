/**
 * walle-multi-machine: bridge-side handler for `resume_on_machine` frames.
 *
 * The resume sibling of `spawn-on-machine-handler.ts`. When the operator
 * re-opens an ENDED laptop/remote session from the dashboard, the server
 * emits a `resume_on_machine` frame over the same WebSocket the bridge
 * already dialed at startup, routed to the bridge whose `machineId` owns the
 * session.
 *
 * Responsibilities (mirror the spawn handler):
 *
 *   1. Resume the local agent at `cwd` for `sessionId` (via the injected
 *      `resumeLocalAgent` callback — `bridge.ts` wires this to a detached
 *      `omp --resume=<sessionId> --cwd <cwd>` / provider-correct `pi` spawn).
 *   2. Track the pending request keyed by `sessionId`. The resumed agent
 *      re-registers under its OWN (unchanged) `sessionId`, so the very first
 *      matching `session_register` clears the entry — the server correlates
 *      the browser's resume click by `sessionId` alone, so (unlike spawn) we
 *      do NOT tag the register with a requestId here.
 *   3. Time the entry out after {@link SPAWN_REGISTER_TIMEOUT_MS} and emit a
 *      `resume_on_machine_failed` frame upstream so the dashboard surfaces
 *      the failure instead of leaving a silent ghost resume.
 *
 * Pure module — every side effect (shelling out, WebSocket send, clock) is
 * injected through `ResumeOnMachineContext`, mirroring the spawn handler so
 * the unit tests in `__tests__/resume-on-machine-handler.test.ts` are
 * exhaustive without mocking timers, files, or sockets.
 *
 * Same sessionId twice → second overwrites the first; the first is treated
 * as timed out (emits `AGENT_DIDNT_REGISTER` immediately) so the dashboard
 * never leaves a requestId dangling, exactly as the spawn handler does for a
 * colliding cwd.
 *
 * See change: walle-multi-machine.
 */
import type {
  SessionRegisterMessage,
  ResumeOnMachineExtensionMessage,
  ResumeOnMachineFailedToServerMessage,
} from "@blackbelt-technology/pi-dashboard-shared/protocol.js";
import { SPAWN_REGISTER_TIMEOUT_MS } from "./spawn-on-machine-handler.js";

export interface PendingResume {
  requestId: string;
  sessionId: string;
  cwd: string;
  mode: "continue" | "fork";
  expiresAt: number;
}

export interface ResumeOnMachineContext {
  /** Sends a message to the upstream dashboard. */
  sendUpstream: (msg: unknown) => void;
  /** Resumes the local agent for an ended session. Provider-specific (omp / pi). */
  resumeLocalAgent: (
    sessionId: string,
    cwd: string,
    mode: "continue" | "fork",
  ) => Promise<void>;
  /** Stable monotonic clock for tests. Production passes `Date.now`. */
  now: () => number;
  /**
   * Optional structured logger. Defaults to console.warn / console.error.
   * Tests inject a capture array so warnings/errors don't leak to stderr.
   */
  logger?: { warn: (msg: string) => void; error: (msg: string) => void };
}

export interface ResumeOnMachineHandler {
  /**
   * Process an inbound `resume_on_machine` frame: resume the local agent
   * and remember the pending resume so the next register can clear it.
   */
  handle(msg: ResumeOnMachineExtensionMessage): Promise<void>;
  /**
   * Inspect every outbound `session_register`. When a register's
   * `sessionId` matches a pending resume, clear the entry (so the watchdog
   * doesn't fire) and return the message UNCHANGED — the server correlates
   * the resume click by `sessionId`, so no requestId tag is added.
   * Non-matching registers pass through verbatim, so this hook is safe to
   * chain after the spawn handler at the connection's `send` boundary.
   */
  onSessionRegister(msg: SessionRegisterMessage): SessionRegisterMessage;
  /**
   * Expire any pending entry whose `expiresAt` is in the past, emitting a
   * `resume_on_machine_failed` frame upstream for each. The bridge drives
   * this on a periodic timer; tests call it manually after advancing the
   * injected clock.
   */
  tickTimeouts(): void;
  /** Test-only: read-only snapshot of the pending map. */
  _peekPending(): ReadonlyMap<string, PendingResume>;
}

export function createResumeOnMachineHandler(
  ctx: ResumeOnMachineContext,
): ResumeOnMachineHandler {
  const pending = new Map<string, PendingResume>();
  const log = ctx.logger ?? {
    warn: (m: string) => console.warn(m),
    error: (m: string) => console.error(m),
  };

  function emitFailure(
    entry: PendingResume,
    code: ResumeOnMachineFailedToServerMessage["code"],
    detail: string,
  ): void {
    const out: ResumeOnMachineFailedToServerMessage = {
      type: "resume_on_machine_failed",
      requestId: entry.requestId,
      sessionId: entry.sessionId,
      code,
      detail,
    };
    ctx.sendUpstream(out);
  }

  return {
    async handle(msg) {
      const existing = pending.get(msg.sessionId);
      if (existing) {
        // Second overwrites the first; the first is treated as timed out so
        // the dashboard never leaves a requestId dangling. Emit BEFORE
        // registering the new entry so the failure carries the OLD requestId.
        log.warn(
          `[dashboard] resume_on_machine: collision on sessionId=${msg.sessionId}; ` +
            `superseding pending requestId=${existing.requestId} with ${msg.requestId} ` +
            `(first treated as AGENT_DIDNT_REGISTER)`,
        );
        emitFailure(
          existing,
          "AGENT_DIDNT_REGISTER",
          `Superseded by a newer resume_on_machine for the same sessionId before the agent could re-register.`,
        );
      }
      const entry: PendingResume = {
        requestId: msg.requestId,
        sessionId: msg.sessionId,
        cwd: msg.cwd,
        mode: msg.mode,
        expiresAt: ctx.now() + SPAWN_REGISTER_TIMEOUT_MS,
      };
      pending.set(msg.sessionId, entry);

      try {
        await ctx.resumeLocalAgent(msg.sessionId, msg.cwd, msg.mode);
      } catch (err) {
        // resumeLocalAgent threw outright — the child won't come, so drop the
        // entry now and report instead of waiting out the watchdog. Guard
        // against a same-sessionId supersede that already replaced our entry:
        // only drop if our requestId is still the one in the map.
        const current = pending.get(msg.sessionId);
        if (current && current.requestId === msg.requestId) {
          pending.delete(msg.sessionId);
        }
        const detail = err instanceof Error ? err.message : String(err);
        log.error(
          `[dashboard] resume_on_machine: resumeLocalAgent threw for sessionId=${msg.sessionId} requestId=${msg.requestId}: ${detail}`,
        );
        emitFailure(entry, "AGENT_INVOKE_FAILED", detail);
      }
    },

    onSessionRegister(msg) {
      const entry = pending.get(msg.sessionId);
      if (!entry) return msg;
      pending.delete(msg.sessionId);
      // Server correlates the resume by sessionId; return unchanged.
      return msg;
    },

    tickTimeouts() {
      const t = ctx.now();
      // Collect first to avoid emitting under the iterator (sendUpstream is
      // host-supplied; we don't trust it to be sync-clean).
      const expired: PendingResume[] = [];
      for (const [sessionId, entry] of pending) {
        if (t < entry.expiresAt) continue;
        expired.push(entry);
        pending.delete(sessionId);
      }
      for (const entry of expired) {
        emitFailure(
          entry,
          "AGENT_DIDNT_REGISTER",
          `Local agent did not re-send session_register within ${SPAWN_REGISTER_TIMEOUT_MS}ms ` +
            `after resume_on_machine(sessionId=${entry.sessionId}, requestId=${entry.requestId}).`,
        );
      }
    },

    _peekPending() {
      return pending;
    },
  };
}
