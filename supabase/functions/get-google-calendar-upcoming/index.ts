import { getGoogleAccessTokenForUser } from "../_shared/google-calendar.ts";
import { handleOptions, jsonResponse } from "../_shared/http.ts";
import { resolveSessionUser } from "../_shared/session.ts";

type GoogleEvent = {
  id: string;
  summary?: string;
  description?: string;
  status?: string;
  htmlLink?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
};

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

  try {
    const auth = await getGoogleAccessTokenForUser(sessionUser.userId);
    const apiUrl = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(auth.calendarId)}/events`
    );
    apiUrl.searchParams.set("timeMin", new Date().toISOString());
    apiUrl.searchParams.set("singleEvents", "true");
    apiUrl.searchParams.set("orderBy", "startTime");
    apiUrl.searchParams.set("maxResults", "15");

    const response = await fetch(apiUrl.toString(), {
      headers: { authorization: `Bearer ${auth.accessToken}` }
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const lower = text.toLowerCase();
      console.error("[get-google-calendar-upcoming] google_fetch_failed", {
        status: response.status,
        text: text.slice(0, 300)
      });
      if (response.status === 401) {
        return jsonResponse({ ok: false, error: "calendar_auth_expired" }, 401);
      }
      if (response.status === 403) {
        return jsonResponse({ ok: false, error: "calendar_permission_denied" }, 403);
      }
      if (response.status === 404) {
        return jsonResponse({ ok: false, error: "calendar_not_found" }, 404);
      }
      if (lower.includes("insufficient") || lower.includes("permission")) {
        return jsonResponse({ ok: false, error: "calendar_permission_denied" }, 403);
      }
      return jsonResponse({ ok: false, error: "calendar_upcoming_fetch_failed" }, 502);
    }

    const payload = (await response.json().catch(() => null)) as { items?: GoogleEvent[] } | null;
    const items = (payload?.items ?? []).map((item) => ({
      id: item.id,
      title: item.summary ?? "(Без назви)",
      description: item.description ?? null,
      status: item.status ?? null,
      htmlLink: item.htmlLink ?? null,
      startAt: item.start?.dateTime ?? item.start?.date ?? null,
      endAt: item.end?.dateTime ?? item.end?.date ?? null,
      timezone: item.start?.timeZone ?? item.end?.timeZone ?? null
    }));

    return jsonResponse({ ok: true, items });
  } catch (error) {
    if (error instanceof Error && error.message === "calendar_not_connected") {
      return jsonResponse({ ok: false, error: "calendar_not_connected" }, 400);
    }
    console.error("[get-google-calendar-upcoming] failed", error);
    return jsonResponse({ ok: false, error: "calendar_upcoming_failed" }, 500);
  }
});
