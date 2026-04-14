import { createAdminClient } from "./db.ts";
import { getGoogleAccessTokenForUser } from "./google-calendar.ts";

export type CalendarBlockRow = {
  id: string;
  user_id: string;
  project_id: string | null;
  title: string;
  details: string | null;
  start_at: string;
  end_at: string;
  timezone: string;
  source: "app" | "google";
  calendar_provider: string;
  provider_calendar_id: string;
  provider_event_id: string | null;
  provider_event_url: string | null;
  provider_status: string | null;
  is_all_day: boolean;
  is_recurring: boolean;
  recurrence_rule: string | null;
  recurrence_timezone: string | null;
  recurrence_parent_provider_event_id: string | null;
  archived_at: string | null;
};

type SupabaseAdminClient = ReturnType<typeof createAdminClient>;

type GoogleCalendarApiEvent = {
  calendarId?: string;
  id: string;
  summary?: string | null;
  description?: string | null;
  status?: string | null;
  htmlLink?: string | null;
  recurringEventId?: string | null;
  recurrence?: string[] | null;
  start?: { dateTime?: string | null; date?: string | null; timeZone?: string | null };
  end?: { dateTime?: string | null; date?: string | null; timeZone?: string | null };
};

type GoogleEventPayload = {
  summary: string;
  description?: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
  recurrence?: string[];
};

export type CalendarBlockInput = {
  title: string;
  details?: string | null;
  startAt: string;
  endAt: string;
  timezone?: string | null;
  projectId?: string | null;
  recurrenceRule?: string | null;
  recurrenceTimezone?: string | null;
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

function toAllDayDateTime(value: string, boundary: "start" | "end"): string {
  return `${value}T${boundary === "start" ? "00:00:00.000" : "00:00:00.000"}Z`;
}

function parseGoogleEvent(event: GoogleCalendarApiEvent): {
  title: string;
  details: string | null;
  startAt: string;
  endAt: string;
  timezone: string;
  providerStatus: string | null;
  providerEventUrl: string | null;
  isAllDay: boolean;
  isRecurring: boolean;
  recurrenceRule: string | null;
  recurrenceTimezone: string;
  recurrenceParentProviderEventId: string | null;
} | null {
  const startDateTime = event.start?.dateTime ?? null;
  const endDateTime = event.end?.dateTime ?? null;
  const startDate = event.start?.date ?? null;
  const endDate = event.end?.date ?? null;

  if (startDateTime && endDateTime) {
    return {
      title: event.summary?.trim() || "(\u0411\u0435\u0437 \u043d\u0430\u0437\u0432\u0438)",
      details: event.description?.trim() || null,
      startAt: new Date(startDateTime).toISOString(),
      endAt: new Date(endDateTime).toISOString(),
      timezone: normalizeTimezone(event.start?.timeZone ?? event.end?.timeZone ?? null),
      providerStatus: event.status ?? null,
      providerEventUrl: event.htmlLink ?? null,
      isAllDay: false,
      isRecurring: Boolean(event.recurringEventId || (event.recurrence?.length ?? 0) > 0),
      recurrenceRule: event.recurrence?.[0] ?? null,
      recurrenceTimezone: normalizeTimezone(event.start?.timeZone ?? event.end?.timeZone ?? null),
      recurrenceParentProviderEventId: event.recurringEventId ?? null
    };
  }

  if (startDate && endDate) {
    return {
      title: event.summary?.trim() || "(\u0411\u0435\u0437 \u043d\u0430\u0437\u0432\u0438)",
      details: event.description?.trim() || null,
      startAt: toAllDayDateTime(startDate, "start"),
      endAt: toAllDayDateTime(endDate, "end"),
      timezone: normalizeTimezone(event.start?.timeZone ?? event.end?.timeZone ?? null),
      providerStatus: event.status ?? null,
      providerEventUrl: event.htmlLink ?? null,
      isAllDay: true,
      isRecurring: Boolean(event.recurringEventId || (event.recurrence?.length ?? 0) > 0),
      recurrenceRule: event.recurrence?.[0] ?? null,
      recurrenceTimezone: normalizeTimezone(event.start?.timeZone ?? event.end?.timeZone ?? null),
      recurrenceParentProviderEventId: event.recurringEventId ?? null
    };
  }

  return null;
}

function googleEventsUrl(calendarId: string, eventId?: string): string {
  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
  return eventId ? `${base}/${encodeURIComponent(eventId)}` : base;
}

export async function listGoogleCalendarEvents(input: {
  userId: string;
  timeMin: string;
  timeMax: string;
  maxResults?: number;
}): Promise<GoogleCalendarApiEvent[]> {
  const auth = await getGoogleAccessTokenForUser(input.userId);
  const perCalendarMax = Math.max(25, Math.min(input.maxResults ?? 250, 250));
  const settled = await Promise.allSettled(
    auth.selectedCalendarIds.map(async (calendarId) => {
      const apiUrl = new URL(googleEventsUrl(calendarId));
      apiUrl.searchParams.set("singleEvents", "true");
      apiUrl.searchParams.set("orderBy", "startTime");
      apiUrl.searchParams.set("timeMin", input.timeMin);
      apiUrl.searchParams.set("timeMax", input.timeMax);
      apiUrl.searchParams.set("maxResults", String(perCalendarMax));

      const response = await fetch(apiUrl.toString(), {
        headers: { authorization: `Bearer ${auth.accessToken}` }
      });

      const payload = (await response.json().catch(() => null)) as { items?: GoogleCalendarApiEvent[] } | null;
      if (!response.ok) {
        throw new Error(response.status === 401 ? "calendar_auth_expired" : response.status === 404 ? "calendar_not_found" : `calendar_blocks_fetch_failed_${response.status}`);
      }

      return (payload?.items ?? []).map((event) => ({ ...event, calendarId }));
    })
  );

  const successfulResponses = settled
    .filter((result): result is PromiseFulfilledResult<GoogleCalendarApiEvent[]> => result.status === "fulfilled")
    .map((result) => result.value);

  const failures = settled
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason instanceof Error ? result.reason.message : "calendar_blocks_fetch_failed");

  if (successfulResponses.length === 0 && failures.length > 0) {
    throw new Error(failures[0]);
  }

  if (failures.length > 0) {
    console.warn("[calendar-blocks] some selected calendars failed to fetch", { failures });
  }

  return successfulResponses
    .flat()
    .sort((a, b) => {
      const aStart = parseGoogleEvent(a)?.startAt ?? "";
      const bStart = parseGoogleEvent(b)?.startAt ?? "";
      return new Date(aStart).getTime() - new Date(bStart).getTime();
    });
}

async function createGoogleEvent(userId: string, calendarId: string, payload: GoogleEventPayload): Promise<{ id: string; htmlLink: string | null; status: string | null }> {
  const auth = await getGoogleAccessTokenForUser(userId);
  const response = await fetch(googleEventsUrl(calendarId), {
    method: "POST",
    headers: {
      authorization: `Bearer ${auth.accessToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const body = (await response.json().catch(() => null)) as { id?: string; htmlLink?: string | null; status?: string | null } | null;
  if (!response.ok || !body?.id) {
    throw new Error(response.status === 404 ? "calendar_event_not_found" : `calendar_block_create_failed_${response.status}`);
  }

  return { id: body.id, htmlLink: body.htmlLink ?? null, status: body.status ?? null };
}

async function updateGoogleEvent(userId: string, calendarId: string, providerEventId: string, payload: GoogleEventPayload): Promise<{ id: string; htmlLink: string | null; status: string | null }> {
  const auth = await getGoogleAccessTokenForUser(userId);
  const response = await fetch(googleEventsUrl(calendarId, providerEventId), {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${auth.accessToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const body = (await response.json().catch(() => null)) as { id?: string; htmlLink?: string | null; status?: string | null } | null;
  if (!response.ok || !body?.id) {
    throw new Error(response.status === 404 ? "calendar_event_not_found" : `calendar_block_update_failed_${response.status}`);
  }

  return { id: body.id, htmlLink: body.htmlLink ?? null, status: body.status ?? null };
}

async function deleteGoogleEvent(userId: string, calendarId: string, providerEventId: string): Promise<void> {
  const auth = await getGoogleAccessTokenForUser(userId);
  const response = await fetch(googleEventsUrl(calendarId, providerEventId), {
    method: "DELETE",
    headers: { authorization: `Bearer ${auth.accessToken}` }
  });

  if (response.ok || response.status === 404) return;
  throw new Error(`calendar_block_delete_failed_${response.status}`);
}

async function resolveRecurringOccurrence(input: {
  userId: string;
  calendarId: string;
  masterEventId: string;
  startAt: string;
  endAt: string;
}): Promise<{ providerCalendarId: string; providerEventId: string; providerEventUrl: string | null; providerStatus: string | null } | null> {
  const searchStart = new Date(new Date(input.startAt).getTime() - 12 * 60 * 60 * 1000).toISOString();
  const searchEnd = new Date(new Date(input.endAt).getTime() + 36 * 60 * 60 * 1000).toISOString();
  const events = await listGoogleCalendarEvents({
    userId: input.userId,
    timeMin: searchStart,
    timeMax: searchEnd,
    maxResults: 40
  });

  const match = events.find((event) => {
    const parsed = parseGoogleEvent(event);
    if (!parsed) return false;
    const sameSeries = event.recurringEventId === input.masterEventId || event.id === input.masterEventId;
    return sameSeries && event.calendarId === input.calendarId && parsed.startAt === new Date(input.startAt).toISOString();
  });

  if (!match) return null;
  return {
    providerCalendarId: match.calendarId ?? input.calendarId,
    providerEventId: match.id,
    providerEventUrl: match.htmlLink ?? null,
    providerStatus: match.status ?? null
  };
}

function toGooglePayload(input: CalendarBlockInput & { isAllDay?: boolean }): GoogleEventPayload {
  const timezone = normalizeTimezone(input.timezone ?? null);
  const recurrence = input.recurrenceRule ? [input.recurrenceRule] : undefined;
  if (input.isAllDay) {
    const startDate = input.startAt.slice(0, 10);
    const endDate = input.endAt.slice(0, 10);
    return {
      summary: input.title.trim() || "\u0411\u0435\u0437 \u043d\u0430\u0437\u0432\u0438",
      description: input.details?.trim() || undefined,
      start: { date: startDate, timeZone: timezone },
      end: { date: endDate, timeZone: timezone },
      recurrence
    };
  }

  return {
    summary: input.title.trim() || "\u0411\u0435\u0437 \u043d\u0430\u0437\u0432\u0438",
    description: input.details?.trim() || undefined,
    start: { dateTime: new Date(input.startAt).toISOString(), timeZone: timezone },
    end: { dateTime: new Date(input.endAt).toISOString(), timeZone: timezone },
    recurrence
  };
}

async function selectBlocksByProviderIds(
  supabase: SupabaseAdminClient,
  userId: string,
  providerKeys: Array<{ providerCalendarId: string; providerEventId: string }>
) {
  if (providerKeys.length === 0) return [] as CalendarBlockRow[];
  const calendarIds = Array.from(new Set(providerKeys.map((item) => item.providerCalendarId)));
  const eventIds = Array.from(new Set(providerKeys.map((item) => item.providerEventId)));
  const { data, error } = await supabase
    .from("calendar_blocks")
    .select("id, user_id, project_id, title, details, start_at, end_at, timezone, source, calendar_provider, provider_calendar_id, provider_event_id, provider_event_url, provider_status, is_all_day, is_recurring, recurrence_rule, recurrence_timezone, recurrence_parent_provider_event_id, archived_at")
    .eq("user_id", userId)
    .eq("calendar_provider", "google")
    .in("provider_calendar_id", calendarIds)
    .in("provider_event_id", eventIds);
  if (error) throw error;
  const allowedKeys = new Set(providerKeys.map((item) => `${item.providerCalendarId}:${item.providerEventId}`));
  return ((data as CalendarBlockRow[] | null) ?? []).filter((row) =>
    row.provider_event_id ? allowedKeys.has(`${row.provider_calendar_id}:${row.provider_event_id}`) : false
  );
}

export async function syncCalendarBlocksFromGoogle(input: {
  userId: string;
  timeMin: string;
  timeMax: string;
  maxResults?: number;
}): Promise<CalendarBlockRow[]> {
  const supabase = createAdminClient();
  const events = await listGoogleCalendarEvents(input);
  const providerKeys = events.map((event) => ({ providerCalendarId: event.calendarId ?? "primary", providerEventId: event.id })).filter((item) => item.providerEventId);
  const existing = await selectBlocksByProviderIds(supabase, input.userId, providerKeys);
  const existingMap = new Map(existing.map((row) => [`${row.provider_calendar_id}:${row.provider_event_id ?? ""}`, row]));
  const normalizedRows = events
    .map((event) => {
      const parsed = parseGoogleEvent(event);
      if (!parsed) return null;
      const providerCalendarId = event.calendarId ?? "primary";
      const existingRow = existingMap.get(`${providerCalendarId}:${event.id}`);
      return {
        existingId: existingRow?.id ?? null,
        row: {
          user_id: input.userId,
          project_id: existingRow?.project_id ?? null,
          title: parsed.title,
          details: parsed.details,
          start_at: parsed.startAt,
          end_at: parsed.endAt,
          timezone: parsed.timezone,
          source: existingRow?.source ?? "google",
          calendar_provider: "google",
          provider_calendar_id: providerCalendarId,
          provider_event_id: event.id,
          provider_event_url: parsed.providerEventUrl,
          provider_status: parsed.providerStatus,
          is_all_day: parsed.isAllDay,
          is_recurring: parsed.isRecurring,
          recurrence_rule: existingRow?.recurrence_rule ?? parsed.recurrenceRule,
          recurrence_timezone: existingRow?.recurrence_timezone ?? parsed.recurrenceTimezone,
          recurrence_parent_provider_event_id: parsed.recurrenceParentProviderEventId,
          archived_at: null
        }
      };
    })
    .filter((item): item is { existingId: string | null; row: Omit<CalendarBlockRow, "id"> } => Boolean(item));

  const inserts = normalizedRows.filter((item) => !item.existingId).map((item) => item.row);
  const updates = normalizedRows.filter((item) => item.existingId);

  if (inserts.length > 0) {
    const { error } = await supabase.from("calendar_blocks").insert(inserts);
    if (error) throw error;
  }

  for (const item of updates) {
    const { error } = await supabase.from("calendar_blocks").update(item.row).eq("id", item.existingId!).eq("user_id", input.userId);
    if (error) throw error;
  }

  const synced = await selectBlocksByProviderIds(supabase, input.userId, providerKeys);
  return synced.sort((a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime());
}

export async function listLocalCalendarBlocks(input: {
  userId: string;
  timeMin: string;
  timeMax: string;
}): Promise<CalendarBlockRow[]> {
  const supabase = createAdminClient();
  let query = supabase
    .from("calendar_blocks")
    .select("id, user_id, project_id, title, details, start_at, end_at, timezone, source, calendar_provider, provider_calendar_id, provider_event_id, provider_event_url, provider_status, is_all_day, is_recurring, recurrence_rule, recurrence_timezone, recurrence_parent_provider_event_id, archived_at")
    .eq("user_id", input.userId)
    .is("archived_at", null)
    .gte("end_at", input.timeMin)
    .lte("start_at", input.timeMax)
    .order("start_at", { ascending: true });

  try {
    const auth = await getGoogleAccessTokenForUser(input.userId);
    query = query.in("provider_calendar_id", auth.selectedCalendarIds);
  } catch {
    // Keep local fallback usable even if Google auth is temporarily unavailable.
  }

  const { data, error } = await query;
  if (error) throw error;
  return (data as CalendarBlockRow[] | null) ?? [];
}

export async function getCalendarBlockById(userId: string, id: string): Promise<CalendarBlockRow | null> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("calendar_blocks")
    .select("id, user_id, project_id, title, details, start_at, end_at, timezone, source, calendar_provider, provider_calendar_id, provider_event_id, provider_event_url, provider_status, is_all_day, is_recurring, recurrence_rule, recurrence_timezone, recurrence_parent_provider_event_id, archived_at")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return (data as CalendarBlockRow | null) ?? null;
}

export async function upsertCalendarBlock(input: { userId: string; blockId?: string | null; payload: CalendarBlockInput }): Promise<CalendarBlockRow> {
  const supabase = createAdminClient();
  const auth = await getGoogleAccessTokenForUser(input.userId);
  const targetCalendarId = auth.defaultCalendarId;
  const timezone = normalizeTimezone(input.payload.timezone ?? null);
  const recurrenceRule = input.payload.recurrenceRule ?? null;
  const recurrenceTimezone = input.payload.recurrenceTimezone ?? timezone;
  const isRecurring = Boolean(recurrenceRule);

  if (input.blockId) {
    const existing = await getCalendarBlockById(input.userId, input.blockId);
    if (!existing) throw new Error("calendar_block_not_found");
    if (existing.is_all_day) throw new Error("calendar_block_all_day_read_only");

    let remote: { id: string; htmlLink: string | null; status: string | null };
    try {
      remote = await updateGoogleEvent(
        input.userId,
        existing.provider_calendar_id,
        existing.provider_event_id ?? "",
        toGooglePayload({ ...input.payload, timezone, recurrenceRule, recurrenceTimezone })
      );
    } catch (error) {
      if (error instanceof Error && error.message === "calendar_event_not_found") {
        remote = await createGoogleEvent(input.userId, existing.provider_calendar_id, toGooglePayload({ ...input.payload, timezone, recurrenceRule, recurrenceTimezone }));
      } else {
        throw error;
      }
    }

    const resolvedOccurrence = isRecurring
      ? await resolveRecurringOccurrence({
          userId: input.userId,
          calendarId: existing.provider_calendar_id,
          masterEventId: existing.recurrence_parent_provider_event_id ?? remote.id,
          startAt: input.payload.startAt,
          endAt: input.payload.endAt
        })
      : null;

    const { data, error } = await supabase
      .from("calendar_blocks")
      .update({
        project_id: input.payload.projectId ?? null,
        title: input.payload.title.trim(),
        details: input.payload.details?.trim() || null,
        start_at: new Date(input.payload.startAt).toISOString(),
        end_at: new Date(input.payload.endAt).toISOString(),
        timezone,
        source: existing.source,
        calendar_provider: "google",
        provider_calendar_id: resolvedOccurrence?.providerCalendarId ?? existing.provider_calendar_id,
        provider_event_id: resolvedOccurrence?.providerEventId ?? remote.id,
        provider_event_url: resolvedOccurrence?.providerEventUrl ?? remote.htmlLink,
        provider_status: resolvedOccurrence?.providerStatus ?? remote.status,
        archived_at: null,
        is_recurring: isRecurring,
        recurrence_rule: recurrenceRule,
        recurrence_timezone: recurrenceTimezone,
        recurrence_parent_provider_event_id: isRecurring ? existing.recurrence_parent_provider_event_id ?? remote.id : null
      })
      .eq("id", existing.id)
      .eq("user_id", input.userId)
      .select("id, user_id, project_id, title, details, start_at, end_at, timezone, source, calendar_provider, provider_calendar_id, provider_event_id, provider_event_url, provider_status, is_all_day, is_recurring, recurrence_rule, recurrence_timezone, recurrence_parent_provider_event_id, archived_at")
      .single();

    if (error) throw error;
    return data as CalendarBlockRow;
  }

  const remote = await createGoogleEvent(input.userId, targetCalendarId, toGooglePayload({ ...input.payload, timezone, recurrenceRule, recurrenceTimezone }));
  const resolvedOccurrence = isRecurring
    ? await resolveRecurringOccurrence({
        userId: input.userId,
        calendarId: targetCalendarId,
        masterEventId: remote.id,
        startAt: input.payload.startAt,
        endAt: input.payload.endAt
      })
    : null;
  const { data, error } = await supabase
    .from("calendar_blocks")
    .insert({
      user_id: input.userId,
      project_id: input.payload.projectId ?? null,
      title: input.payload.title.trim(),
      details: input.payload.details?.trim() || null,
      start_at: new Date(input.payload.startAt).toISOString(),
      end_at: new Date(input.payload.endAt).toISOString(),
      timezone,
      source: "app",
      calendar_provider: "google",
      provider_calendar_id: resolvedOccurrence?.providerCalendarId ?? targetCalendarId,
      provider_event_id: resolvedOccurrence?.providerEventId ?? remote.id,
      provider_event_url: resolvedOccurrence?.providerEventUrl ?? remote.htmlLink,
      provider_status: resolvedOccurrence?.providerStatus ?? remote.status,
      is_all_day: false,
      is_recurring: isRecurring,
      recurrence_rule: recurrenceRule,
      recurrence_timezone: recurrenceTimezone,
      recurrence_parent_provider_event_id: isRecurring ? remote.id : null
    })
    .select("id, user_id, project_id, title, details, start_at, end_at, timezone, source, calendar_provider, provider_calendar_id, provider_event_id, provider_event_url, provider_status, is_all_day, is_recurring, recurrence_rule, recurrence_timezone, recurrence_parent_provider_event_id, archived_at")
    .single();
  if (error) throw error;
  return data as CalendarBlockRow;
}

export async function deleteCalendarBlock(input: { userId: string; blockId: string }): Promise<void> {
  const supabase = createAdminClient();
  const existing = await getCalendarBlockById(input.userId, input.blockId);
  if (!existing) throw new Error("calendar_block_not_found");
  if (existing.provider_event_id) {
    await deleteGoogleEvent(input.userId, existing.provider_calendar_id, existing.provider_event_id);
  }
  const { error } = await supabase.from("calendar_blocks").delete().eq("id", existing.id).eq("user_id", input.userId);
  if (error) throw error;
}



