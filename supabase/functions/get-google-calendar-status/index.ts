import {
  calendarSelectionState,
  getGoogleConnection,
  probeGoogleTasksAccess
} from "../_shared/google-calendar.ts";
import { handleOptions, jsonResponse } from "../_shared/http.ts";
import { resolveSessionUser } from "../_shared/session.ts";

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
    const connection = await getGoogleConnection(sessionUser.userId);
    const selection = calendarSelectionState(connection);
    const tasksAccess = connection
      ? await probeGoogleTasksAccess(sessionUser.userId)
      : { state: "not_connected" as const, errorCode: "calendar_not_connected", taskLists: [] };

    return jsonResponse({
      ok: true,
      connected: Boolean(connection),
      provider: "google",
      email: connection?.google_email ?? null,
      calendarId: selection.defaultCalendarId ?? null,
      selectedCalendarIds: connection ? selection.selectedCalendarIds : [],
      defaultCalendarId: connection ? selection.defaultCalendarId : null,
      defaultTaskListId: connection ? selection.defaultTaskListId : null,
      tasksScopeAvailable: tasksAccess.state === "usable",
      tasksAccessState: tasksAccess.state,
      tasksAccessError: tasksAccess.errorCode,
      expiresAt: connection?.expires_at ?? null
    });
  } catch (error) {
    console.error("[get-google-calendar-status] failed", error);
    return jsonResponse({ ok: false, error: "calendar_status_failed" }, 500);
  }
});
