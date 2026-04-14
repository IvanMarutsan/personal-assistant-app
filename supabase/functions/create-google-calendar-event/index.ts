import { createAdminClient } from "../_shared/db.ts";
import { getGoogleAccessTokenForUser } from "../_shared/google-calendar.ts";
import { handleOptions, jsonResponse, safeJson } from "../_shared/http.ts";
import { resolveSessionUser } from "../_shared/session.ts";

type CreateEventBody = {
  title?: string;
  description?: string;
  startAt?: string;
  endAt?: string;
  durationMinutes?: number;
  timezone?: string;
  sourceInboxItemId?: string;
  sourceTaskId?: string;
  sourceNoteId?: string;
};

function parseIso(input: string | undefined): Date | null {
  if (!input?.trim()) return null;
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function normalizeTimezone(value: string | null | undefined): string {
  const candidate = value?.trim();
  if (!candidate) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return "UTC";
  }
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

  const body = await safeJson<CreateEventBody>(req);
  const title = body?.title?.trim();
  const startAt = parseIso(body?.startAt);
  const endAtDirect = parseIso(body?.endAt);

  if (!title) return jsonResponse({ ok: false, error: "missing_title" }, 400);
  if (!startAt) return jsonResponse({ ok: false, error: "missing_or_invalid_start" }, 400);

  let endAt = endAtDirect;
  if (!endAt) {
    const duration = Number(body?.durationMinutes ?? 30);
    if (!Number.isFinite(duration) || duration <= 0) {
      return jsonResponse({ ok: false, error: "invalid_duration" }, 400);
    }
    endAt = new Date(startAt.getTime() + duration * 60_000);
  }

  if (endAt <= startAt) {
    return jsonResponse({ ok: false, error: "invalid_time_range" }, 400);
  }

  try {
    const supabase = createAdminClient();
    const { data: profile } = await supabase
      .from("profiles")
      .select("timezone")
      .eq("user_id", sessionUser.userId)
      .maybeSingle();
    const timezone = normalizeTimezone(body?.timezone ?? ((profile?.timezone as string | null | undefined) ?? null));

    if (body?.sourceTaskId) {
      const { data: taskOwned } = await supabase
        .from("tasks")
        .select("id")
        .eq("id", body.sourceTaskId)
        .eq("user_id", sessionUser.userId)
        .maybeSingle();
      if (!taskOwned) {
        return jsonResponse({ ok: false, error: "task_not_found" }, 404);
      }
    }

    if (body?.sourceNoteId) {
      const { data: noteOwned } = await supabase
        .from("notes")
        .select("id")
        .eq("id", body.sourceNoteId)
        .eq("user_id", sessionUser.userId)
        .maybeSingle();
      if (!noteOwned) {
        return jsonResponse({ ok: false, error: "note_not_found" }, 404);
      }
    }

    const auth = await getGoogleAccessTokenForUser(sessionUser.userId);
    const targetCalendarId = auth.defaultCalendarId;
    const apiUrl = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(targetCalendarId)}/events`;

    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${auth.accessToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        summary: title,
        description: body?.description?.trim() || undefined,
        start: { dateTime: startAt.toISOString(), timeZone: timezone },
        end: { dateTime: endAt.toISOString(), timeZone: timezone }
      })
    });

    const payload = (await response.json().catch(() => null)) as
      | { id?: string; htmlLink?: string; status?: string }
      | null;

    if (!response.ok || !payload?.id) {
      console.error("[create-google-calendar-event] google_create_failed", {
        status: response.status,
        payload
      });
      return jsonResponse({ ok: false, error: "calendar_event_create_failed" }, 502);
    }

    const { error: linkError } = await supabase.from("calendar_event_links").insert({
      user_id: sessionUser.userId,
      provider: "google",
      provider_calendar_id: targetCalendarId,
      provider_event_id: payload.id,
      inbox_item_id: body?.sourceInboxItemId ?? null,
      task_id: body?.sourceTaskId ?? null,
      note_id: body?.sourceNoteId ?? null,
      title,
      starts_at: startAt.toISOString(),
      ends_at: endAt.toISOString(),
      timezone,
      provider_event_url: payload.htmlLink ?? null
    });

    if (linkError) {
      console.error("[create-google-calendar-event] calendar_event_links_insert_failed", linkError);
    }

    if (body?.sourceTaskId) {
      const { error: taskUpdateError } = await supabase
        .from("tasks")
        .update({
          calendar_provider: "google",
          calendar_provider_calendar_id: targetCalendarId,
          calendar_event_id: payload.id,
          calendar_sync_mode: "manual",
          calendar_sync_error: null
        })
        .eq("id", body.sourceTaskId)
        .eq("user_id", sessionUser.userId);

      if (taskUpdateError) {
        console.error("[create-google-calendar-event] task_link_update_failed", taskUpdateError);
      }
    }

    return jsonResponse({
      ok: true,
      event: {
        id: payload.id,
        htmlLink: payload.htmlLink ?? null,
        status: payload.status ?? null,
        title,
        startAt: startAt.toISOString(),
        endAt: endAt.toISOString(),
        timezone
      }
    });
  } catch (error) {
    if (error instanceof Error && error.message === "calendar_not_connected") {
      return jsonResponse({ ok: false, error: "calendar_not_connected" }, 400);
    }
    console.error("[create-google-calendar-event] failed", error);
    return jsonResponse({ ok: false, error: "calendar_event_create_failed" }, 500);
  }
});

