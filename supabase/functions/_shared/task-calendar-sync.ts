import { createAdminClient } from "./db.ts";
import { getGoogleAccessTokenForUser } from "./google-calendar.ts";

export type TaskCalendarSyncMode = "app_managed" | "manual";

export type TaskCalendarSyncRow = {
  id: string;
  user_id: string;
  title: string;
  details: string | null;
  status: string;
  due_at: string | null;
  scheduled_for: string | null;
  estimated_minutes: number | null;
  calendar_provider: string | null;
  calendar_provider_calendar_id: string | null;
  calendar_event_id: string | null;
  calendar_sync_mode: TaskCalendarSyncMode | null;
  calendar_sync_error: string | null;
};

type SupabaseAdminClient = ReturnType<typeof createAdminClient>;

type GoogleEventPayload = {
  summary: string;
  description?: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
};

type GoogleEventResult = {
  id: string;
  htmlLink: string | null;
};

type GoogleEventSnapshot = {
  id: string;
  htmlLink: string | null;
  summary: string | null;
  timezone: string | null;
  startAt: string;
  endAt: string;
};

export type TaskCalendarInboundState =
  | {
      status: "manual" | "not_linked" | "healthy";
      message: string | null;
    }
  | {
      status: "changed";
      message: string;
      remoteScheduledFor: string;
      remoteEstimatedMinutes: number;
    }
  | {
      status: "missing";
      message: string;
    }
  | {
      status: "unsupported";
      message: string;
    };

type TaskCalendarSyncOptions = {
  ignoreInboundConflict?: boolean;
};

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

function formatForDescription(value: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("uk-UA", {
      dateStyle: "short",
      timeStyle: "short",
      timeZone: timezone
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function buildTaskEventDescription(task: TaskCalendarSyncRow, timezone: string): string | undefined {
  const parts: string[] = [];
  const details = task.details?.trim();
  if (details) parts.push(details);
  if (task.due_at) parts.push(`Дедлайн: ${formatForDescription(task.due_at, timezone)}`);
  if (task.estimated_minutes) parts.push(`Оцінка: ${task.estimated_minutes} хв`);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function buildTaskGoogleEvent(task: TaskCalendarSyncRow, timezone: string): GoogleEventPayload | null {
  if (!task.scheduled_for) return null;
  const start = new Date(task.scheduled_for);
  if (Number.isNaN(start.getTime())) return null;
  const durationMinutes = task.estimated_minutes && task.estimated_minutes > 0 ? task.estimated_minutes : 30;
  const end = new Date(start.getTime() + durationMinutes * 60_000);

  return {
    summary: task.title.trim() || "Задача",
    description: buildTaskEventDescription(task, timezone),
    start: { dateTime: start.toISOString(), timeZone: timezone },
    end: { dateTime: end.toISOString(), timeZone: timezone }
  };
}

async function loadUserTimezone(supabase: SupabaseAdminClient, userId: string): Promise<string> {
  const { data } = await supabase.from("profiles").select("timezone").eq("user_id", userId).maybeSingle();
  return normalizeTimezone((data?.timezone as string | null | undefined) ?? null);
}

function googleEventUrl(calendarId: string, eventId?: string): string {
  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
  return eventId ? `${base}/${encodeURIComponent(eventId)}` : base;
}

async function googleCreateEvent(userId: string, calendarId: string, payload: GoogleEventPayload): Promise<GoogleEventResult> {
  const auth = await getGoogleAccessTokenForUser(userId);
  const response = await fetch(googleEventUrl(calendarId), {
    method: "POST",
    headers: {
      authorization: `Bearer ${auth.accessToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const body = (await response.json().catch(() => null)) as { id?: string; htmlLink?: string | null } | null;
  if (!response.ok || !body?.id) {
    throw new Error(response.status === 404 ? "calendar_event_not_found" : `calendar_event_create_failed_${response.status}`);
  }

  return { id: body.id, htmlLink: body.htmlLink ?? null };
}

async function googleUpdateEvent(userId: string, calendarId: string, eventId: string, payload: GoogleEventPayload): Promise<GoogleEventResult> {
  const auth = await getGoogleAccessTokenForUser(userId);
  const response = await fetch(googleEventUrl(calendarId, eventId), {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${auth.accessToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const body = (await response.json().catch(() => null)) as { id?: string; htmlLink?: string | null } | null;
  if (!response.ok || !body?.id) {
    throw new Error(response.status === 404 ? "calendar_event_not_found" : `calendar_event_update_failed_${response.status}`);
  }

  return { id: body.id, htmlLink: body.htmlLink ?? null };
}

async function googleGetEvent(userId: string, calendarId: string, eventId: string): Promise<GoogleEventSnapshot> {
  const auth = await getGoogleAccessTokenForUser(userId);
  const response = await fetch(googleEventUrl(calendarId, eventId), {
    method: "GET",
    headers: {
      authorization: `Bearer ${auth.accessToken}`
    }
  });

  const body = (await response.json().catch(() => null)) as
    | {
        id?: string;
        htmlLink?: string | null;
        summary?: string | null;
        start?: { dateTime?: string; timeZone?: string | null };
        end?: { dateTime?: string; timeZone?: string | null };
      }
    | null;

  if (!response.ok || !body?.id) {
    throw new Error(response.status === 404 ? "calendar_event_not_found" : `calendar_event_fetch_failed_${response.status}`);
  }

  const startAt = body.start?.dateTime ?? null;
  const endAt = body.end?.dateTime ?? null;
  if (!startAt || !endAt) {
    throw new Error("calendar_event_unsupported_time");
  }

  return {
    id: body.id,
    htmlLink: body.htmlLink ?? null,
    summary: body.summary ?? null,
    timezone: body.start?.timeZone ?? body.end?.timeZone ?? null,
    startAt,
    endAt
  };
}

async function googleDeleteEvent(userId: string, calendarId: string, eventId: string): Promise<void> {
  const auth = await getGoogleAccessTokenForUser(userId);
  const response = await fetch(googleEventUrl(calendarId, eventId), {
    method: "DELETE",
    headers: {
      authorization: `Bearer ${auth.accessToken}`
    }
  });

  if (response.ok || response.status === 404) return;
  throw new Error(`calendar_event_delete_failed_${response.status}`);
}

async function upsertCalendarEventLink(input: {
  supabase: SupabaseAdminClient;
  task: TaskCalendarSyncRow;
  providerCalendarId: string;
  providerEventId: string;
  providerEventUrl: string | null;
  timezone: string;
  startsAt: string;
  endsAt: string;
}): Promise<void> {
  const { supabase, task } = input;
  const { error } = await supabase.from("calendar_event_links").upsert(
    {
      user_id: task.user_id,
      provider: "google",
      provider_calendar_id: input.providerCalendarId,
      provider_event_id: input.providerEventId,
      task_id: task.id,
      note_id: null,
      inbox_item_id: null,
      title: task.title.trim() || "Задача",
      starts_at: input.startsAt,
      ends_at: input.endsAt,
      timezone: input.timezone,
      provider_event_url: input.providerEventUrl
    },
    { onConflict: "user_id,provider,provider_calendar_id,provider_event_id" }
  );

  if (error) throw error;
}

function deriveEstimatedMinutesFromRemoteEvent(event: GoogleEventSnapshot): number | null {
  const startMs = new Date(event.startAt).getTime();
  const endMs = new Date(event.endAt).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  const minutes = Math.round((endMs - startMs) / 60_000);
  return minutes > 0 ? minutes : null;
}

function sameInstant(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  const aMs = new Date(a).getTime();
  const bMs = new Date(b).getTime();
  if (!Number.isFinite(aMs) || !Number.isFinite(bMs)) return a === b;
  return aMs === bMs;
}

function normalizeEstimatedMinutes(value: number | null | undefined): number {
  return value && value > 0 ? value : 30;
}

async function syncCalendarLinkFromRemoteEvent(input: {
  supabase: SupabaseAdminClient;
  task: TaskCalendarSyncRow;
  event: GoogleEventSnapshot;
}): Promise<void> {
  await upsertCalendarEventLink({
    supabase: input.supabase,
    task: input.task,
    providerCalendarId: input.task.calendar_provider_calendar_id ?? "primary",
    providerEventId: input.event.id,
    providerEventUrl: input.event.htmlLink,
    timezone: normalizeTimezone(input.event.timezone),
    startsAt: new Date(input.event.startAt).toISOString(),
    endsAt: new Date(input.event.endAt).toISOString()
  });
}

async function clearCalendarLinksForTask(
  supabase: SupabaseAdminClient,
  taskId: string,
  eventId?: string | null
): Promise<void> {
  let query = supabase.from("calendar_event_links").delete().eq("task_id", taskId).eq("provider", "google");
  if (eventId) query = query.eq("provider_event_id", eventId);
  const { error } = await query;
  if (error) throw error;
}

async function updateTaskCalendarFields(
  supabase: SupabaseAdminClient,
  taskId: string,
  userId: string,
  patch: Record<string, unknown>
): Promise<void> {
  const { error } = await supabase.from("tasks").update(patch).eq("id", taskId).eq("user_id", userId);
  if (error) throw error;
}

export async function loadTaskForCalendarSync(
  supabase: SupabaseAdminClient,
  userId: string,
  taskId: string
): Promise<TaskCalendarSyncRow | null> {
  const { data, error } = await supabase
    .from("tasks")
    .select(
      "id, user_id, title, details, status, due_at, scheduled_for, estimated_minutes, calendar_provider, calendar_provider_calendar_id, calendar_event_id, calendar_sync_mode, calendar_sync_error"
    )
    .eq("id", taskId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  return (data as TaskCalendarSyncRow | null) ?? null;
}

async function inspectTaskInboundCalendarChangeFromTask(
  supabase: SupabaseAdminClient,
  task: TaskCalendarSyncRow
): Promise<TaskCalendarInboundState> {
  const hasGoogleLink = task.calendar_provider === "google" && !!task.calendar_event_id;
  if (!hasGoogleLink) {
    return {
      status: "not_linked",
      message: null
    };
  }

  const manualProtected =
    task.calendar_sync_mode === "manual" || (!!task.calendar_event_id && task.calendar_sync_mode !== "app_managed");

  if (manualProtected) {
    return {
      status: "manual",
      message: "Подію прив’язано вручну."
    };
  }

  if (task.calendar_sync_mode !== "app_managed") {
    return {
      status: "not_linked",
      message: null
    };
  }

  let remoteEvent: GoogleEventSnapshot;
  try {
    remoteEvent = await googleGetEvent(task.user_id, task.calendar_provider_calendar_id ?? "primary", task.calendar_event_id!);
  } catch (error) {
    const message = error instanceof Error ? error.message : "calendar_event_fetch_failed";
    if (message === "calendar_event_not_found") {
      return {
        status: "missing",
        message: "Подію більше не знайдено в Google Calendar."
      };
    }
    if (message === "calendar_event_unsupported_time") {
      return {
        status: "unsupported",
        message: "Формат часу події в Google Calendar не підтримується."
      };
    }
    throw error;
  }

  await syncCalendarLinkFromRemoteEvent({ supabase, task, event: remoteEvent });
  const remoteEstimatedMinutes = deriveEstimatedMinutesFromRemoteEvent(remoteEvent);
  if (!remoteEstimatedMinutes) {
    return {
      status: "unsupported",
      message: "Формат тривалості події в Google Calendar не підтримується."
    };
  }

  const scheduledChanged = !sameInstant(task.scheduled_for, remoteEvent.startAt);
  const durationChanged = normalizeEstimatedMinutes(task.estimated_minutes) !== remoteEstimatedMinutes;

  if (!scheduledChanged && !durationChanged) {
    return {
      status: "healthy",
      message: null
    };
  }

  return {
    status: "changed",
    message: "Подію змінено в Google Calendar.",
    remoteScheduledFor: new Date(remoteEvent.startAt).toISOString(),
    remoteEstimatedMinutes
  };
}

export async function syncTaskCalendarAfterMutation(
  supabase: SupabaseAdminClient,
  userId: string,
  taskId: string,
  options: TaskCalendarSyncOptions = {}
): Promise<void> {
  try {
    const task = await loadTaskForCalendarSync(supabase, userId, taskId);
    if (!task) return;

    const manualProtected =
      task.calendar_sync_mode === "manual" || (!!task.calendar_event_id && task.calendar_sync_mode !== "app_managed");

    if (manualProtected) {
      if (task.calendar_sync_error) {
        await updateTaskCalendarFields(supabase, task.id, userId, { calendar_sync_error: null });
      }
      return;
    }

    const shouldRemoveManagedEvent =
      task.calendar_sync_mode === "app_managed" &&
      task.calendar_provider === "google" &&
      !!task.calendar_provider_calendar_id &&
      !!task.calendar_event_id &&
      (!task.scheduled_for || task.status === "done");

    if (shouldRemoveManagedEvent) {
      let deleteError: string | null = null;

      try {
        await googleDeleteEvent(userId, task.calendar_provider_calendar_id!, task.calendar_event_id!);
      } catch (error) {
        deleteError = error instanceof Error ? error.message : "calendar_sync_delete_failed";
      }

      if (!deleteError) {
        try {
          await clearCalendarLinksForTask(supabase, task.id, task.calendar_event_id);
        } catch (error) {
          deleteError = error instanceof Error ? error.message : "calendar_link_delete_failed";
        }
      }

      await updateTaskCalendarFields(
        supabase,
        task.id,
        userId,
        deleteError
          ? {
              calendar_sync_error: deleteError
            }
          : {
              calendar_provider: null,
              calendar_provider_calendar_id: null,
              calendar_event_id: null,
              calendar_sync_mode: null,
              calendar_sync_error: null
            }
      );
      return;
    }

    if (!task.scheduled_for || task.status === "done") {
      if (task.calendar_sync_error) {
        await updateTaskCalendarFields(supabase, task.id, userId, { calendar_sync_error: null });
      }
      return;
    }

    const timezone = await loadUserTimezone(supabase, userId);
    const eventPayload = buildTaskGoogleEvent(task, timezone);
    if (!eventPayload) {
      await updateTaskCalendarFields(supabase, task.id, userId, {
        calendar_sync_error: "calendar_sync_invalid_scheduled_for"
      });
      return;
    }

    let eventResult: GoogleEventResult;
    let staleEventId: string | null = null;
    const auth = await getGoogleAccessTokenForUser(userId);
    const targetCalendarId = task.calendar_provider_calendar_id || auth.defaultCalendarId;

    if (task.calendar_sync_mode === "app_managed" && task.calendar_provider === "google" && task.calendar_event_id) {
      if (!options.ignoreInboundConflict) {
        const inboundState = await inspectTaskInboundCalendarChangeFromTask(supabase, task);
        if (inboundState.status === "changed") {
          await updateTaskCalendarFields(supabase, task.id, userId, {
            calendar_sync_error: "calendar_inbound_change_pending"
          });
          return;
        }
        if (inboundState.status === "missing") {
          staleEventId = task.calendar_event_id;
          eventResult = await googleCreateEvent(userId, targetCalendarId, eventPayload);
        } else if (inboundState.status === "unsupported") {
          await updateTaskCalendarFields(supabase, task.id, userId, {
            calendar_sync_error: "calendar_inbound_change_unsupported"
          });
          return;
        } else {
          try {
            eventResult = await googleUpdateEvent(userId, targetCalendarId, task.calendar_event_id, eventPayload);
          } catch (error) {
            const message = error instanceof Error ? error.message : "calendar_event_update_failed";
            if (message !== "calendar_event_not_found") throw error;
            staleEventId = task.calendar_event_id;
            eventResult = await googleCreateEvent(userId, targetCalendarId, eventPayload);
          }
        }
      } else {
        try {
          eventResult = await googleUpdateEvent(userId, targetCalendarId, task.calendar_event_id, eventPayload);
        } catch (error) {
          const message = error instanceof Error ? error.message : "calendar_event_update_failed";
          if (message !== "calendar_event_not_found") throw error;
          staleEventId = task.calendar_event_id;
          eventResult = await googleCreateEvent(userId, targetCalendarId, eventPayload);
        }
      }
    } else if (!task.calendar_event_id) {
      eventResult = await googleCreateEvent(userId, targetCalendarId, eventPayload);
    } else {
      return;
    }

    if (staleEventId) {
      try {
        await clearCalendarLinksForTask(supabase, task.id, staleEventId);
      } catch (_error) {
        // Keep retry/create successful even if stale link cleanup lags behind.
      }
    }

    await upsertCalendarEventLink({
      supabase,
      task,
      providerCalendarId: targetCalendarId,
      providerEventId: eventResult.id,
      providerEventUrl: eventResult.htmlLink,
      timezone,
      startsAt: eventPayload.start.dateTime,
      endsAt: eventPayload.end.dateTime
    });

    await updateTaskCalendarFields(supabase, task.id, userId, {
      calendar_provider: "google",
      calendar_provider_calendar_id: targetCalendarId,
      calendar_event_id: eventResult.id,
      calendar_sync_mode: "app_managed",
      calendar_sync_error: null
    });
  } catch (error) {
    console.error("[task-calendar-sync] sync_failed", { taskId, userId, error });
    try {
      await updateTaskCalendarFields(supabase, taskId, userId, {
        calendar_sync_error: error instanceof Error ? error.message : "calendar_sync_failed"
      });
    } catch (_innerError) {
      // Keep task mutation successful even if sync diagnostics also fail.
    }
  }
}

export async function inspectTaskInboundCalendarChange(
  supabase: SupabaseAdminClient,
  userId: string,
  taskId: string
): Promise<TaskCalendarInboundState> {
  const task = await loadTaskForCalendarSync(supabase, userId, taskId);
  if (!task) {
    throw new Error("task_not_found");
  }

  return await inspectTaskInboundCalendarChangeFromTask(supabase, task);
}

export async function applyTaskInboundCalendarChange(
  supabase: SupabaseAdminClient,
  userId: string,
  taskId: string
): Promise<TaskCalendarInboundState> {
  const task = await loadTaskForCalendarSync(supabase, userId, taskId);
  if (!task) {
    throw new Error("task_not_found");
  }

  const state = await inspectTaskInboundCalendarChangeFromTask(supabase, task);
  if (state.status !== "changed") {
    return state;
  }

  await updateTaskCalendarFields(supabase, task.id, userId, {
    scheduled_for: state.remoteScheduledFor,
    estimated_minutes: state.remoteEstimatedMinutes,
    calendar_sync_error: null
  });

  return {
    status: "healthy",
    message: "Зміни з Google Calendar застосовано."
  };
}

export async function keepTaskLocalCalendarVersion(
  supabase: SupabaseAdminClient,
  userId: string,
  taskId: string
): Promise<TaskCalendarInboundState> {
  const task = await loadTaskForCalendarSync(supabase, userId, taskId);
  if (!task) {
    throw new Error("task_not_found");
  }

  const hasGoogleLink = task.calendar_provider === "google" && !!task.calendar_event_id;
  if (!hasGoogleLink) {
    return {
      status: "not_linked",
      message: null
    };
  }

  const manualProtected =
    task.calendar_sync_mode === "manual" || (!!task.calendar_event_id && task.calendar_sync_mode !== "app_managed");
  if (manualProtected) {
    return {
      status: "manual",
      message: "Подію прив’язано вручну."
    };
  }

  await syncTaskCalendarAfterMutation(supabase, userId, taskId, { ignoreInboundConflict: true });

  return {
    status: "healthy",
    message: "Версію з додатку збережено в Google Calendar."
  };
}

export async function detachTaskCalendarLink(
  supabase: SupabaseAdminClient,
  task: TaskCalendarSyncRow
): Promise<"manual_unlinked" | "app_managed_deleted"> {
  const hasGoogleLink = task.calendar_provider === "google" && !!task.calendar_event_id;
  if (!hasGoogleLink) {
    throw new Error("calendar_link_not_found");
  }

  const manualProtected =
    task.calendar_sync_mode === "manual" || (!!task.calendar_event_id && task.calendar_sync_mode !== "app_managed");

  if (manualProtected) {
    await clearCalendarLinksForTask(supabase, task.id, task.calendar_event_id);
    await updateTaskCalendarFields(supabase, task.id, task.user_id, {
      calendar_provider: null,
      calendar_provider_calendar_id: null,
      calendar_event_id: null,
      calendar_sync_mode: null,
      calendar_sync_error: null
    });
    return "manual_unlinked";
  }

  if (task.calendar_sync_mode !== "app_managed") {
    throw new Error("calendar_link_detach_not_allowed");
  }

  await googleDeleteEvent(task.user_id, task.calendar_provider_calendar_id ?? "primary", task.calendar_event_id);
  await clearCalendarLinksForTask(supabase, task.id, task.calendar_event_id);
  await updateTaskCalendarFields(supabase, task.id, task.user_id, {
    calendar_provider: null,
    calendar_provider_calendar_id: null,
    calendar_event_id: null,
    calendar_sync_mode: null,
    calendar_sync_error: null
  });
  return "app_managed_deleted";
}

export async function cleanupDeletedTaskCalendarSync(
  supabase: SupabaseAdminClient,
  task: TaskCalendarSyncRow
): Promise<void> {
  if (task.calendar_sync_mode !== "app_managed" || task.calendar_provider !== "google" || !task.calendar_event_id) {
    return;
  }

  try {
    await googleDeleteEvent(task.user_id, task.calendar_provider_calendar_id ?? "primary", task.calendar_event_id);
  } catch (_error) {
    // Deleting the task in the app still wins in V1. Remote orphan cleanup can come later.
  }

  try {
    await clearCalendarLinksForTask(supabase, task.id, task.calendar_event_id);
  } catch (_error) {
    // Ignore local link cleanup failure for V1 delete path.
  }
}
