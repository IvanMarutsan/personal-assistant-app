import { handleOptions, jsonResponse, safeJson } from "../_shared/http.ts";
import { resolveSessionUser } from "../_shared/session.ts";
import { createAdminClient } from "../_shared/db.ts";
import { upsertCalendarBlock } from "../_shared/calendar-blocks.ts";
import { buildSupportedRecurrenceRule, parseSupportedRecurrenceFrequency } from "../_shared/recurrence.ts";
type Body = {
  id?: string | null;
  title?: string;
  details?: string | null;
  startAt?: string;
  endAt?: string;
  timezone?: string | null;
  projectId?: string | null;
  recurrenceFrequency?: string | null;
};
function parseIso(input: string | undefined): string | null {
  if (!input?.trim()) return null;
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}
function mapCalendarBlockError(error: Error): { status: number; code: string; details?: string } {
  const message = error.message;
  if (message === "calendar_block_not_found") return { status: 404, code: "calendar_block_not_found" };
  if (message === "calendar_block_all_day_read_only") return { status: 400, code: "calendar_block_all_day_read_only" };
  if (message === "calendar_not_connected") return { status: 400, code: "calendar_not_connected" };
  if (message === "calendar_refresh_token_missing") return { status: 401, code: "calendar_auth_expired" };
  if (message.endsWith("_401")) return { status: 401, code: "calendar_auth_expired", details: message };
  if (message.endsWith("_403")) return { status: 403, code: "calendar_permission_denied", details: message };
  if (message.endsWith("_400")) return { status: 400, code: "calendar_invalid_request", details: message };
  return { status: 500, code: "calendar_block_upsert_failed", details: message };
}
Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
  }
  const sessionUser = await resolveSessionUser(req);
  if (!sessionUser) {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  }
  const body = await safeJson<Body>(req);
  const title = body?.title?.trim();
  const startAt = parseIso(body?.startAt);
  const endAt = parseIso(body?.endAt);
  const recurrenceFrequency = parseSupportedRecurrenceFrequency(body?.recurrenceFrequency ?? null);
  const recurrenceRule = buildSupportedRecurrenceRule(recurrenceFrequency);
  if (!title) return jsonResponse({ ok: false, error: "missing_title" }, 400);
  if (!startAt || !endAt) return jsonResponse({ ok: false, error: "invalid_time_range" }, 400);
  if (new Date(endAt).getTime() <= new Date(startAt).getTime()) {
    return jsonResponse({ ok: false, error: "invalid_time_range" }, 400);
  }
  if (body?.recurrenceFrequency !== undefined && body?.recurrenceFrequency !== null && !recurrenceFrequency) {
    return jsonResponse({ ok: false, error: "invalid_recurrence_frequency" }, 400);
  }
  try {
    if (body?.projectId) {
      const supabase = createAdminClient();
      const { data } = await supabase.from("projects").select("id").eq("id", body.projectId).eq("user_id", sessionUser.userId).maybeSingle();
      if (!data) {
        return jsonResponse({ ok: false, error: "project_not_found" }, 404);
      }
    }
    const block = await upsertCalendarBlock({
      userId: sessionUser.userId,
      blockId: body?.id ?? null,
      payload: {
        title,
        details: body?.details ?? null,
        startAt,
        endAt,
        timezone: body?.timezone ?? null,
        projectId: body?.projectId ?? null,
        recurrenceRule,
        recurrenceTimezone: recurrenceRule ? body?.timezone ?? "UTC" : null
      }
    });
    return jsonResponse({ ok: true, block });
  } catch (error) {
    if (error instanceof Error) {
      const mapped = mapCalendarBlockError(error);
      console.error("[upsert-calendar-block] failed", { code: mapped.code, details: mapped.details ?? null });
      return jsonResponse({ ok: false, error: mapped.code, details: mapped.details ?? null }, mapped.status);
    }
    console.error("[upsert-calendar-block] failed", error);
    return jsonResponse({ ok: false, error: "calendar_block_upsert_failed" }, 500);
  }
});
