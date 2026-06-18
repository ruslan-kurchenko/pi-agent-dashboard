/**
 * walle-multi-machine: pure arg-builders for the bridge's detached agent
 * spawns. Extracted from `bridge.ts`'s `invokeLocalAgent` / `resumeLocalAgent`
 * so the flag construction is unit-testable without the bridge's side effects.
 *
 * Root cause this fixes: the bridge previously spawned a bare `omp [prompt]`
 * (no subcommand, no `--mode rpc`) detached with `stdio:"ignore"` — a TTY-less
 * TUI that boots, connects the bridge (arch→online), then sits idle
 * (`ui.loop-blocked`) and never creates a session. Headless mode is
 * `--mode rpc` (RPC-mode pi, no TTY, driven over the bridge WebSocket via
 * in-process `pi.sendUserMessage`).
 *
 * Both omp (v16) and pi (v0.79) accept `--mode rpc`, `--model`, `--thinking`.
 * Only omp accepts `--cwd`; pi has no `--cwd` flag, so for pi the child's
 * working directory carries the cwd (set via the spawn `cwd` option, not argv).
 *
 * See change: dashboard-session-model-select.
 */

export type AgentProvider = "omp" | "pi";

export interface SpawnAgentArgsOptions {
  /** Working directory. Emitted as `--cwd` for omp only; pi carries it via the spawn cwd. */
  cwd: string;
  /** Optional model override → `--model <model>`. Omitted → agent default. */
  model?: string;
  /** Optional thinking level → `--thinking <thinking>`. Omitted → agent default. */
  thinking?: string;
}

/**
 * Build the argv for a fresh headless agent spawn. Always headless
 * (`--mode rpc`); `--cwd` only for omp. `--model` / `--thinking` only when
 * provided. NOTE: the first prompt is NOT passed here — `--mode rpc` ignores
 * positional messages (it waits for a stdin/in-process RPC turn). The bridge
 * delivers it via the PI_DASHBOARD_INITIAL_PROMPT env var instead.
 */
export function buildSpawnAgentArgs(
  provider: AgentProvider,
  opts: SpawnAgentArgsOptions,
): string[] {
  return [
    "--mode",
    "rpc",
    ...(provider === "omp" ? ["--cwd", opts.cwd] : []),
    ...(opts.model ? ["--model", opts.model] : []),
    ...(opts.thinking ? ["--thinking", opts.thinking] : []),
  ];
}

export interface ResumeAgentArgsOptions {
  /** Session id (prefix) to resume. */
  resumeSessionId: string;
  /** Working directory. Emitted as `--cwd` for omp only; pi carries it via the spawn cwd. */
  cwd: string;
}

/**
 * Build the argv for a headless resume. omp resumes by id with
 * `--resume=<id> --cwd <cwd>`; pi resumes by id via `--session <id>` (its
 * `-r` is an interactive picker), with cwd carried by the child's working
 * directory. Both are made headless with `--mode rpc` so a resumed session
 * is never a TTY-less TUI zombie either.
 */
export function buildResumeAgentArgs(
  provider: AgentProvider,
  opts: ResumeAgentArgsOptions,
): string[] {
  if (provider === "pi") {
    return ["--mode", "rpc", "--session", opts.resumeSessionId];
  }
  return ["--mode", "rpc", `--resume=${opts.resumeSessionId}`, "--cwd", opts.cwd];
}
