import { handleOptions, jsonResponse } from "../_shared/http.ts";
import { resolveSessionUser } from "../_shared/session.ts";
import { listLocalCalendarBlocks, syncCalendarBlocksFromGoogle } from "../_shared/calendar-blocks.ts";

function parseIso(value: string | null): string | null {
  if (!value?.trim()) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "GET") {
    return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
  }

  const sessionUser = await resolveSessionUser(req);
  if (!sessionUser) {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  }

  const url = new URL(req.url);
  const timeMin = parseIso(url.searchParams.get("timeMin")) ?? new Date().toISOString();
  const timeMax = parseIso(url.searchParams.get("timeMax")) ?? new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
  const maxResults = Number(url.searchParams.get("maxResults") ?? "250");

  try {
    const blocks = await syncCalendarBlocksFromGoogle({
      userId: sessionUser.userId,
      timeMin,
      timeMax,
      maxResults: Number.isFinite(maxResults) && maxResults > 0 ? Math.min(maxResults, 250) : 250
    });
    return jsonResponse({ ok: true, items: blocks });
  } catch (error) {
    console.error("[get-calendar-blocks] sync_failed", error);

    try {
      const localBlocks = await listLocalCalendarBlocks({ userId: sessionUser.userId, timeMin, timeMax });
      return jsonResponse({
        ok: true,
        items: localBlocks,
        stale: true,
        syncError: error instanceof Error ? error.message : "calendar_blocks_fetch_failed"
      });
    } catch (localError) {
      console.error("[get-calendar-blocks] local_fallback_failed", localError);
      return jsonResponse({ ok: false, error: "calendar_blocks_fetch_failed" }, 500);
    }
  }
});
