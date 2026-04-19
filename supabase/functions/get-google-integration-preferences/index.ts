import {
  calendarSelectionState,
  getGoogleConnection,
  listGoogleCalendars,
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
    if (!connection) {
      return jsonResponse({
        ok: true,
        connected: false,
        calendars: [],
        taskLists: [],
        selectedCalendarIds: [],
        defaultCalendarId: null,
        defaultTaskListId: null,
        tasksScopeAvailable: false,
        tasksAccessState: "not_connected",
        tasksAccessError: "calendar_not_connected"
      });
    }

    const calendars = await listGoogleCalendars(sessionUser.userId);
    const selection = calendarSelectionState(connection);
    const selectedCalendarIds = calendars.filter((calendar) => calendar.selected).map((calendar) => calendar.id);
    const defaultCalendarId = calendars.find((calendar) => calendar.default)?.id ?? selection.defaultCalendarId;
    const tasksAccess = await probeGoogleTasksAccess(sessionUser.userId);
    const taskLists = tasksAccess.taskLists;

    return jsonResponse({
      ok: true,
      connected: true,
      calendars,
      taskLists,
      selectedCalendarIds,
      defaultCalendarId,
      defaultTaskListId: selection.defaultTaskListId,
      tasksScopeAvailable: tasksAccess.state === "usable",
      tasksAccessState: tasksAccess.state,
      tasksAccessError: tasksAccess.errorCode
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "google_integration_preferences_failed";
    if (message === "calendar_not_connected") {
      return jsonResponse({
        ok: true,
        connected: false,
        calendars: [],
        taskLists: [],
        selectedCalendarIds: [],
        defaultCalendarId: null,
        defaultTaskListId: null,
        tasksScopeAvailable: false,
        tasksAccessState: "not_connected",
        tasksAccessError: "calendar_not_connected"
      });
    }
    if (message === "google_tasks_scope_missing") {
      const connection = await getGoogleConnection(sessionUser.userId);
      const selection = calendarSelectionState(connection);
      const calendars = await listGoogleCalendars(sessionUser.userId);
      return jsonResponse({
        ok: true,
        connected: true,
        calendars,
        taskLists: [],
        selectedCalendarIds: calendars.filter((calendar) => calendar.selected).map((calendar) => calendar.id),
        defaultCalendarId: calendars.find((calendar) => calendar.default)?.id ?? selection.defaultCalendarId,
        defaultTaskListId: selection.defaultTaskListId,
        tasksScopeAvailable: false,
        tasksAccessState: "scope_missing",
        tasksAccessError: "google_tasks_scope_missing"
      });
    }
    console.error("[get-google-integration-preferences] failed", error);
    return jsonResponse({ ok: false, error: "google_integration_preferences_failed", details: message }, 500);
  }
});
