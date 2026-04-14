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
    const settled = await Promise.allSettled(
      auth.selectedCalendarIds.map(async (calendarId) => {
        const apiUrl = new URL(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`
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
            calendarId,
            status: response.status,
            text: text.slice(0, 300)
          });
          if (response.status === 401) throw new Error("calendar_auth_expired");
          if (response.status === 403 || lower.includes("insufficient") || lower.includes("permission")) throw new Error("calendar_permission_denied");
          if (response.status === 404) throw new Error("calendar_not_found");
          throw new Error("calendar_upcoming_fetch_failed");
        }

        const payload = (await response.json().catch(() => null)) as { items?: GoogleEvent[] } | null;
        return (payload?.items ?? []).map((item) => ({
          id: item.id,
          title: item.summary ?? "(Без назви)",
          description: item.description ?? null,
          status: item.status ?? null,
          htmlLink: item.htmlLink ?? null,
          startAt: item.start?.dateTime ?? item.start?.date ?? null,
          endAt: item.end?.dateTime ?? item.end?.date ?? null,
          timezone: item.start?.timeZone ?? item.end?.timeZone ?? null
        }));
      })
    );

    const successes = settled
      .filter((result): result is PromiseFulfilledResult<Array<{
        id: string;
        title: string;
        description: string | null;
        status: string | null;
        htmlLink: string | null;
        startAt: string | null;
        endAt: string | null;
        timezone: string | null;
      }>> => result.status === "fulfilled")
      .map((result) => result.value);

    const failures = settled
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => (result.reason instanceof Error ? result.reason.message : "calendar_upcoming_fetch_failed"));

    if (successes.length === 0 && failures.length > 0) {
      throw new Error(failures[0]);
    }

    if (failures.length > 0) {
      console.warn("[get-google-calendar-upcoming] partial_calendar_fetch_failed", { failures });
    }

    const items = successes
      .flat()
      .sort((a, b) => new Date(a.startAt ?? 0).getTime() - new Date(b.startAt ?? 0).getTime())
      .slice(0, 15);

    return jsonResponse({ ok: true, items });
  } catch (error) {
    if (error instanceof Error && error.message === "calendar_not_connected") {
      return jsonResponse({ ok: false, error: "calendar_not_connected" }, 400);
    }
    if (error instanceof Error && error.message === "calendar_auth_expired") {
      return jsonResponse({ ok: false, error: "calendar_auth_expired" }, 401);
    }
    if (error instanceof Error && error.message === "calendar_permission_denied") {
      return jsonResponse({ ok: false, error: "calendar_permission_denied" }, 403);
    }
    if (error instanceof Error && error.message === "calendar_not_found") {
      return jsonResponse({ ok: false, error: "calendar_not_found" }, 404);
    }
    console.error("[get-google-calendar-upcoming] failed", error);
    return jsonResponse({ ok: false, error: "calendar_upcoming_failed" }, 500);
  }
});
