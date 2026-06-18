/**
 * Formatting utilities for session card display.
 */

/** Format token count: 12400 → "12.4k", 500 → "500" */
export function formatTokens(value: number): string {
  if (!value || isNaN(value)) return "0";
  if (value < 1000) return String(value);
  const k = value / 1000;
  return k % 1 === 0 ? `${k}k` : `${k.toFixed(1)}k`;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Pad a number to 2 digits */
function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Pad a number to 2 digits for month/day */
function pad2m(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Format a message timestamp for chat display.
 * - Today: "HH:MM:SS"
 * - Yesterday: "Yesterday HH:MM:SS"
 * - 2-6 days ago: "Weekday HH:MM:SS"
 * - Older: "YYYY-MM-DD HH:MM:SS"
 */
export function formatMessageTime(ts: number, now?: number): string {
  const date = new Date(ts);
  const ref = new Date(now ?? Date.now());

  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;

  // Start of today
  const startOfToday = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate()).getTime();
  const startOfYesterday = startOfToday - 86_400_000;
  const tsTime = date.getTime();

  if (tsTime >= startOfToday) {
    return time;
  }
  if (tsTime >= startOfYesterday) {
    return `Yesterday ${time}`;
  }
  // Up to 6 days ago
  const sixDaysAgo = startOfToday - 6 * 86_400_000;
  if (tsTime >= sixDaysAgo) {
    return `${WEEKDAYS[date.getDay()]} ${time}`;
  }
  // Full date
  return `${date.getFullYear()}-${pad2m(date.getMonth() + 1)}-${pad2m(date.getDate())} ${time}`;
}

/** Format millisecond duration to relative time: 180000 → "3m" */
export function formatRelativeTime(ms: number): string {
  if (ms <= 0) return "0s";

  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;

  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/**
 * Sanitize a session model string for display. Returns the trimmed model when
 * it is a real value, else `null`. Live daemon sessions that have not yet
 * surfaced a model — and a `model_select` event whose provider/id are absent
 * (`event-reducer` builds `${provider}/${id}`) — can leak the literal strings
 * "undefined" or "undefined/undefined". Callers render nothing (or "—") on
 * `null` rather than showing that text. See dashboard fix #5 (daemon model
 * "undefined").
 */
export function displayModel(model?: string | null): string | null {
  if (!model) return null;
  const trimmed = model.trim();
  if (!trimmed) return null;
  // Reject whole-string sentinels and any "/"-segment that is a sentinel, so
  // "undefined", "null", "undefined/undefined", and "provider/" all drop out
  // while real "provider/id" labels pass through.
  for (const part of trimmed.split("/")) {
    const p = part.trim().toLowerCase();
    if (p === "" || p === "undefined" || p === "null") return null;
  }
  return trimmed;
}
