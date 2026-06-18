/**
 * Unit tests for `injectToDaemon` — the shared transport that POSTs an
 * operator prompt to the local wall-e daemon `/inject` endpoint.
 *
 * Focus: the optional per-session `model` / `thinkingLevel` overrides
 * (New Session popover) are forwarded into the POST body when set and
 * omitted entirely when absent or empty, so the legacy `{ text, threadId? }`
 * shape is preserved for callers that don't pass them.
 *
 * See change: dashboard-session-model-select.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { injectToDaemon } from "../daemon-inject.js";

function okResponse(threadId = "t-1"): Response {
  return new Response(JSON.stringify({ ok: true, threadId }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function lastBody(calls: Array<[unknown, RequestInit]>): Record<string, unknown> {
  const [, init] = calls[0];
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

describe("injectToDaemon — model/thinkingLevel forwarding", () => {
  const prevPort = process.env.WALLE_DASHBOARD_INBOUND_PORT;

  beforeEach(() => {
    process.env.WALLE_DASHBOARD_INBOUND_PORT = "9333";
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (prevPort === undefined) delete process.env.WALLE_DASHBOARD_INBOUND_PORT;
    else process.env.WALLE_DASHBOARD_INBOUND_PORT = prevPort;
  });

  it("includes model + thinkingLevel in the body when both are set", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse("t-9"));
    const result = await injectToDaemon("hello", "thread-1", {
      model: "anthropic/claude-opus-4-8",
      thinkingLevel: "high",
    });
    expect(result).toEqual({ ok: true, status: 200, threadId: "t-9" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toBe("http://127.0.0.1:9333/inject");
    expect(lastBody(fetchSpy.mock.calls as Array<[unknown, RequestInit]>)).toEqual({
      text: "hello",
      threadId: "thread-1",
      model: "anthropic/claude-opus-4-8",
      thinkingLevel: "high",
    });
  });

  it("includes only the override that is set", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse());
    await injectToDaemon("hi", undefined, { model: "openai-codex/gpt-5.5" });
    expect(lastBody(fetchSpy.mock.calls as Array<[unknown, RequestInit]>)).toEqual({ text: "hi", model: "openai-codex/gpt-5.5" });
  });

  it("omits model + thinkingLevel when opts is undefined (legacy shape preserved)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse());
    await injectToDaemon("hi", "thread-2");
    expect(lastBody(fetchSpy.mock.calls as Array<[unknown, RequestInit]>)).toEqual({ text: "hi", threadId: "thread-2" });
  });

  it("omits model + thinkingLevel when passed as empty strings", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse());
    await injectToDaemon("hi", undefined, { model: "", thinkingLevel: "" });
    expect(lastBody(fetchSpy.mock.calls as Array<[unknown, RequestInit]>)).toEqual({ text: "hi" });
  });
});
