/**
 * walle-multi-machine: shared helper that forwards a prompt to the local
 * wall-e daemon's `dashboard` channel inject endpoint
 * (`http://127.0.0.1:<WALLE_DASHBOARD_INBOUND_PORT||9300>/inject`).
 *
 * Two callers share this transport so the URL/header/body shape stays
 * identical:
 *  - `routes/machines-routes.ts` POST /api/machines/:id/message — the daemon
 *    New-Session path (no threadId → wall-e mints a fresh home-agent thread)
 *    and the ad-hoc daemon-continue path (threadId set).
 *  - `browser-handlers/session-action-handler.ts` handleSendPrompt — the
 *    daemon "Continue" composer path (threadId = session.daemonThreadId).
 *
 * Re-sending the same `threadId` continues that per-thread daemon session
 * (omp resumes context from the session folder); omitting it mints a new one.
 * A configured `WALLE_DASHBOARD_BRIDGE_SECRET` is sent as a Bearer token.
 *
 * See change: walle-multi-machine.
 */

export interface DaemonInjectResult {
  /** True iff the inject endpoint returned a 2xx response. */
  ok: boolean;
  /** wall-e-minted (or echoed) thread id, when the response carried one. */
  threadId?: string;
  /** HTTP status from the inject endpoint, when the request completed. */
  status?: number;
  /** Human-readable failure detail when `ok === false`. */
  error?: string;
}

/**
 * Optional per-session overrides forwarded into the daemon inject body.
 * Chosen in the New Session popover; the daemon router carries them into the
 * spawn so omp launches on the requested model / thinking level. Omitted →
 * the home-agent default. See change: dashboard-session-model-select.
 */
export interface DaemonInjectOptions {
  model?: string;
  thinkingLevel?: string;
}

/**
 * POST `{ text, threadId?, model?, thinkingLevel? }` to the local daemon inject
 * endpoint. Never throws — connection/HTTP failures resolve to
 * `{ ok: false, error }`. `model`/`thinkingLevel` are only included when set.
 */
export async function injectToDaemon(
  text: string,
  threadId?: string,
  opts?: DaemonInjectOptions,
): Promise<DaemonInjectResult> {
  const port = process.env.WALLE_DASHBOARD_INBOUND_PORT || "9300";
  const secret = process.env.WALLE_DASHBOARD_BRIDGE_SECRET;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret) headers.authorization = `Bearer ${secret}`;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/inject`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        text,
        ...(typeof threadId === "string" && threadId ? { threadId } : {}),
        ...(typeof opts?.model === "string" && opts.model ? { model: opts.model } : {}),
        ...(typeof opts?.thinkingLevel === "string" && opts.thinkingLevel
          ? { thinkingLevel: opts.thinkingLevel }
          : {}),
      }),
    });
    if (!r.ok) {
      return { ok: false, status: r.status, error: `daemon inject failed (${r.status})` };
    }
    const data = (await r.json()) as { threadId?: string };
    return { ok: true, status: r.status, threadId: data.threadId };
  } catch (err) {
    return {
      ok: false,
      error: `daemon unreachable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
