import {
  calendarSelectionState,
  getGoogleConnection,
  listGoogleCalendars,
  listGoogleTaskLists,
  updateGoogleConnectionPreferences
} from "../_shared/google-calendar.ts";
import { handleOptions, jsonResponse, safeJson } from "../_shared/http.ts";
import { resolveSessionUser } from "../_shared/session.ts";

type Body = {
  selectedCalendarIds?: string[];
  defaultCalendarId?: string | null;
  defaultTaskListId?: string | null;
};

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
  const selectedCalendarIds = Array.isArray(body?.selectedCalendarIds)
    ? body!.selectedCalendarIds.map((item) => item?.trim()).filter(Boolean)
    : undefined;

  if (selectedCalendarIds !== undefined && selectedCalendarIds.length === 0) {
    return jsonResponse({ ok: false, error: "selected_calendars_required" }, 400);
  }

  try {
    const connection = await getGoogleConnection(sessionUser.userId);
    const currentSelection = calendarSelectionState(connection);
    const calendars = await listGoogleCalendars(sessionUser.userId);
    const calendarIds = new Set(calendars.map((item) => item.id));
    if (selectedCalendarIds && selectedCalendarIds.some((id) => !calendarIds.has(id))) {
      return jsonResponse({ ok: false, error: "invalid_selected_calendar" }, 400);
    }
    if (body?.defaultCalendarId && !calendarIds.has(body.defaultCalendarId)) {
      return jsonResponse({ ok: false, error: "invalid_default_calendar" }, 400);
    }

    let normalizedTaskListId = body?.defaultTaskListId ?? null;
    if (normalizedTaskListId) {
      try {
        const taskLists = await listGoogleTaskLists(sessionUser.userId);
        const taskListIds = new Set(taskLists.map((item) => item.id));
        if (!taskListIds.has(normalizedTaskListId)) {
          return jsonResponse({ ok: false, error: "invalid_default_task_list" }, 400);
        }
      } catch (taskListsError) {
        const taskListsMessage = taskListsError instanceof Error ? taskListsError.message : "google_task_lists_fetch_failed";
        console.warn("[update-google-integration-preferences] task lists unavailable", { taskListsMessage });
        if (["google_tasks_scope_missing", "google_tasks_permission_denied", "google_task_lists_fetch_failed_401", "google_task_lists_fetch_failed_403"].includes(taskListsMessage)) {
          normalizedTaskListId = currentSelection.defaultTaskListId;
        } else {
          throw taskListsError;
        }
      }
    }

    const prefs = await updateGoogleConnectionPreferences({
      userId: sessionUser.userId,
      selectedCalendarIds,
      defaultCalendarId: body?.defaultCalendarId ?? null,
      defaultTaskListId: normalizedTaskListId
    });

    return jsonResponse({ ok: true, preferences: prefs });
  } catch (error) {
    const message = error instanceof Error ? error.message : "calendar_preferences_update_failed";
    if (message === "calendar_not_connected") {
      return jsonResponse({ ok: false, error: "calendar_not_connected" }, 400);
    }
    if (message === "google_tasks_scope_missing") {
      return jsonResponse({ ok: false, error: "google_tasks_scope_missing" }, 400);
    }
    console.error("[update-google-integration-preferences] failed", error);
    return jsonResponse({ ok: false, error: "calendar_preferences_update_failed", details: message }, 500);
  }
});
