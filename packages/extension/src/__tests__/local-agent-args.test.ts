/**
 * walle-multi-machine: unit tests for the bridge's headless agent
 * arg-builders (`buildSpawnAgentArgs` / `buildResumeAgentArgs`) and the
 * `spawn_on_machine` handler's model/thinking pass-through.
 *
 * Regression target: the bridge used to spawn a bare `omp [prompt]` (no
 * `--mode rpc`) detached with `stdio:"ignore"` — a TTY-less TUI zombie that
 * registers but never creates a session. The arg-builder must now ALWAYS emit
 * `--mode rpc` (headless), `--cwd` for omp only, `--model`/`--thinking` only
 * when provided, and the prompt LAST. See change: dashboard-session-model-select.
 */
import { describe, it, expect } from "vitest";
import {
  buildSpawnAgentArgs,
  buildResumeAgentArgs,
} from "../local-agent-args.js";
import { createSpawnOnMachineHandler } from "../spawn-on-machine-handler.js";
import type { SpawnOnMachineExtensionMessage } from "@blackbelt-technology/pi-dashboard-shared/protocol.js";

describe("local-agent-args / buildSpawnAgentArgs (omp)", () => {
  it("always emits --mode rpc + --cwd, nothing else when model/thinking/prompt absent", () => {
    expect(buildSpawnAgentArgs("omp", { cwd: "/work/repo" })).toEqual([
      "--mode",
      "rpc",
      "--cwd",
      "/work/repo",
    ]);
  });

  it("adds --model only when a model is provided", () => {
    expect(
      buildSpawnAgentArgs("omp", { cwd: "/work/repo", model: "anthropic/claude-opus-4-8" }),
    ).toEqual(["--mode", "rpc", "--cwd", "/work/repo", "--model", "anthropic/claude-opus-4-8"]);
  });

  it("adds --thinking only when a thinking level is provided", () => {
    expect(
      buildSpawnAgentArgs("omp", { cwd: "/work/repo", thinking: "high" }),
    ).toEqual(["--mode", "rpc", "--cwd", "/work/repo", "--thinking", "high"]);
  });

  it("appends the prompt LAST as a positional message", () => {
    const args = buildSpawnAgentArgs("omp", { cwd: "/work/repo", prompt: "fix the flaky test" });
    expect(args).toEqual(["--mode", "rpc", "--cwd", "/work/repo", "fix the flaky test"]);
    expect(args[args.length - 1]).toBe("fix the flaky test");
  });

  it("orders flags then prompt: --mode rpc, --cwd, --model, --thinking, <prompt> last", () => {
    const args = buildSpawnAgentArgs("omp", {
      cwd: "/work/repo",
      model: "openai-codex/gpt-5.5",
      thinking: "medium",
      prompt: "do the thing",
    });
    expect(args).toEqual([
      "--mode",
      "rpc",
      "--cwd",
      "/work/repo",
      "--model",
      "openai-codex/gpt-5.5",
      "--thinking",
      "medium",
      "do the thing",
    ]);
    expect(args[args.length - 1]).toBe("do the thing");
  });

  it("omits --model/--thinking for empty-string values (falsy guard)", () => {
    expect(
      buildSpawnAgentArgs("omp", { cwd: "/work/repo", model: "", thinking: "", prompt: "" }),
    ).toEqual(["--mode", "rpc", "--cwd", "/work/repo"]);
  });
});

describe("local-agent-args / buildSpawnAgentArgs (pi)", () => {
  it("emits --mode rpc but NO --cwd (pi has no --cwd flag; cwd carried by spawn cwd)", () => {
    expect(buildSpawnAgentArgs("pi", { cwd: "/work/repo" })).toEqual(["--mode", "rpc"]);
  });

  it("supports --model/--thinking and prompt last, still without --cwd", () => {
    const args = buildSpawnAgentArgs("pi", {
      cwd: "/work/repo",
      model: "anthropic/claude-sonnet-4-5",
      thinking: "low",
      prompt: "hello",
    });
    expect(args).toEqual([
      "--mode",
      "rpc",
      "--model",
      "anthropic/claude-sonnet-4-5",
      "--thinking",
      "low",
      "hello",
    ]);
    expect(args).not.toContain("--cwd");
    expect(args[args.length - 1]).toBe("hello");
  });
});

describe("local-agent-args / buildResumeAgentArgs", () => {
  it("omp resume is headless: --mode rpc --resume=<id> --cwd <cwd>", () => {
    expect(
      buildResumeAgentArgs("omp", { resumeSessionId: "abc123", cwd: "/work/repo" }),
    ).toEqual(["--mode", "rpc", "--resume=abc123", "--cwd", "/work/repo"]);
  });

  it("pi resume is headless: --mode rpc --session <id> (no --cwd)", () => {
    const args = buildResumeAgentArgs("pi", { resumeSessionId: "abc123", cwd: "/work/repo" });
    expect(args).toEqual(["--mode", "rpc", "--session", "abc123"]);
    expect(args).not.toContain("--cwd");
  });
});

describe("spawn-on-machine-handler / model+thinking pass-through", () => {
  function makeFrame(
    extra: Partial<SpawnOnMachineExtensionMessage> = {},
  ): SpawnOnMachineExtensionMessage {
    return { type: "spawn_on_machine", cwd: "/work/repo", requestId: "req-1", ...extra };
  }

  it("forwards model + thinkingLevel from the frame into invokeLocalAgent opts", async () => {
    const invocations: Array<{ cwd: string; opts: Record<string, unknown> }> = [];
    const handler = createSpawnOnMachineHandler({
      sendUpstream: () => {},
      invokeLocalAgent: async (cwd, opts) => {
        invocations.push({ cwd, opts });
      },
      now: () => 1_000_000,
      logger: { warn: () => {}, error: () => {} },
    });

    await handler.handle(
      makeFrame({ prompt: "go", model: "anthropic/claude-opus-4-8", thinkingLevel: "xhigh" }),
    );

    expect(invocations).toEqual([
      {
        cwd: "/work/repo",
        opts: {
          attachProposal: undefined,
          gitWorktreeBase: undefined,
          prompt: "go",
          model: "anthropic/claude-opus-4-8",
          thinkingLevel: "xhigh",
        },
      },
    ]);
  });

  it("leaves model/thinkingLevel undefined when the frame omits them", async () => {
    const invocations: Array<{ opts: Record<string, unknown> }> = [];
    const handler = createSpawnOnMachineHandler({
      sendUpstream: () => {},
      invokeLocalAgent: async (_cwd, opts) => {
        invocations.push({ opts });
      },
      now: () => 1_000_000,
      logger: { warn: () => {}, error: () => {} },
    });

    await handler.handle(makeFrame());

    expect(invocations[0].opts.model).toBeUndefined();
    expect(invocations[0].opts.thinkingLevel).toBeUndefined();
  });
});
