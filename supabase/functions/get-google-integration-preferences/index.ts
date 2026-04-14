import {
  calendarSelectionState,
  getGoogleConnection,
  hasGoogleTasksScope,
  listGoogleCalendars,
  listGoogleTaskLists
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
        tasksScopeAvailable: false
      });
    }

    const calendars = await listGoogleCalendars(sessionUser.userId);
    const selection = calendarSelectionState(connection);
    const selectedCalendarIds = calendars.filter((calendar) => calendar.selected).map((calendar) => calendar.id);
    const defaultCalendarId = calendars.find((calendar) => calendar.default)?.id ?? selection.defaultCalendarId;
    const tasksScopeAvailable = hasGoogleTasksScope(connection.scope);
    let taskLists = [];
    let resolvedTasksScopeAvailable = tasksScopeAvailable;
    if (tasksScopeAvailable) {
      try {
        taskLists = await listGoogleTaskLists(sessionUser.userId);
      } catch (taskListsError) {
        const taskListsMessage = taskListsError instanceof Error ? taskListsError.message : "google_task_lists_fetch_failed";
        console.warn("[get-google-integration-preferences] task lists unavailable", { taskListsMessage });
        if (["google_tasks_scope_missing", "google_tasks_permission_denied", "google_task_lists_fetch_failed_401", "google_task_lists_fetch_failed_403"].includes(taskListsMessage)) {
          resolvedTasksScopeAvailable = false;
        }
        taskLists = [];
      }
    }

    return jsonResponse({
      ok: true,
      connected: true,
      calendars,
      taskLists,
      selectedCalendarIds,
      defaultCalendarId,
      defaultTaskListId: selection.defaultTaskListId,
      tasksScopeAvailable: resolvedTasksScopeAvailable
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
        tasksScopeAvailable: false
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
        tasksScopeAvailable: false
      });
    }
    console.error("[get-google-integration-preferences] failed", error);
    return jsonResponse({ ok: false, error: "google_integration_preferences_failed", details: message }, 500);
  }
});
