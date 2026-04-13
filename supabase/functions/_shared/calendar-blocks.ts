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
  provider_event_id: string | null;
  provider_event_url: string | null;
  provider_status: string | null;
  is_all_day: boolean;
  archived_at: string | null;
};

type SupabaseAdminClient = ReturnType<typeof createAdminClient>;

type GoogleCalendarApiEvent = {
  id: string;
  summary?: string | null;
  description?: string | null;
  status?: string | null;
  htmlLink?: string | null;
  start?: { dateTime?: string | null; date?: string | null; timeZone?: string | null };
  end?: { dateTime?: string | null; date?: string | null; timeZone?: string | null };
};

type GoogleEventPayload = {
  summary: string;
  description?: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
};

export type CalendarBlockInput = {
  title: string;
  details?: string | null;
  startAt: string;
  endAt: string;
  timezone?: string | null;
  projectId?: string | null;
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
      isAllDay: false
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
      isAllDay: true
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
  const apiUrl = new URL(googleEventsUrl(auth.calendarId));
  apiUrl.searchParams.set("singleEvents", "true");
  apiUrl.searchParams.set("orderBy", "startTime");
  apiUrl.searchParams.set("timeMin", input.timeMin);
  apiUrl.searchParams.set("timeMax", input.timeMax);
  apiUrl.searchParams.set("maxResults", String(input.maxResults ?? 250));

  const response = await fetch(apiUrl.toString(), {
    headers: { authorization: `Bearer ${auth.accessToken}` }
  });

  const payload = (await response.json().catch(() => null)) as { items?: GoogleCalendarApiEvent[] } | null;
  if (!response.ok) {
    throw new Error(response.status === 404 ? "calendar_not_found" : `calendar_blocks_fetch_failed_${response.status}`);
  }

  return payload?.items ?? [];
}

async function createGoogleEvent(userId: string, payload: GoogleEventPayload): Promise<{ id: string; htmlLink: string | null; status: string | null }> {
  const auth = await getGoogleAccessTokenForUser(userId);
  const response = await fetch(googleEventsUrl(auth.calendarId), {
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

async function updateGoogleEvent(userId: string, providerEventId: string, payload: GoogleEventPayload): Promise<{ id: string; htmlLink: string | null; status: string | null }> {
  const auth = await getGoogleAccessTokenForUser(userId);
  const response = await fetch(googleEventsUrl(auth.calendarId, providerEventId), {
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

async function deleteGoogleEvent(userId: string, providerEventId: string): Promise<void> {
  const auth = await getGoogleAccessTokenForUser(userId);
  const response = await fetch(googleEventsUrl(auth.calendarId, providerEventId), {
    method: "DELETE",
    headers: { authorization: `Bearer ${auth.accessToken}` }
  });

  if (response.ok || response.status === 404) return;
  throw new Error(`calendar_block_delete_failed_${response.status}`);
}

function toGooglePayload(input: CalendarBlockInput & { isAllDay?: boolean }): GoogleEventPayload {
  const timezone = normalizeTimezone(input.timezone ?? null);
  if (input.isAllDay) {
    const startDate = input.startAt.slice(0, 10);
    const endDate = input.endAt.slice(0, 10);
    return {
      summary: input.title.trim() || "\u0411\u0435\u0437 \u043d\u0430\u0437\u0432\u0438",
      description: input.details?.trim() || undefined,
      start: { date: startDate, timeZone: timezone },
      end: { date: endDate, timeZone: timezone }
    };
  }

  return {
    summary: input.title.trim() || "\u0411\u0435\u0437 \u043d\u0430\u0437\u0432\u0438",
    description: input.details?.trim() || undefined,
    start: { dateTime: new Date(input.startAt).toISOString(), timeZone: timezone },
    end: { dateTime: new Date(input.endAt).toISOString(), timeZone: timezone }
  };
}

async function selectBlocksByProviderIds(supabase: SupabaseAdminClient, userId: string, providerEventIds: string[]) {
  if (providerEventIds.length === 0) return [] as CalendarBlockRow[];
  const { data, error } = await supabase
    .from("calendar_blocks")
    .select("id, user_id, project_id, title, details, start_at, end_at, timezone, source, calendar_provider, provider_event_id, provider_event_url, provider_status, is_all_day, archived_at")
    .eq("user_id", userId)
    .eq("calendar_provider", "google")
    .in("provider_event_id", providerEventIds);
  if (error) throw error;
  return (data as CalendarBlockRow[] | null) ?? [];
}

export async function syncCalendarBlocksFromGoogle(input: {
  userId: string;
  timeMin: string;
  timeMax: string;
  maxResults?: number;
}): Promise<CalendarBlockRow[]> {
  const supabase = createAdminClient();
  const events = await listGoogleCalendarEvents(input);
  const providerIds = events.map((event) => event.id).filter(Boolean);
  const existing = await selectBlocksByProviderIds(supabase, input.userId, providerIds);
  const existingMap = new Map(existing.map((row) => [row.provider_event_id ?? "", row]));

  const upserts = events
    .map((event) => {
      const parsed = parseGoogleEvent(event);
      if (!parsed) return null;
      const existingRow = existingMap.get(event.id);
      return {
        id: existingRow?.id,
        user_id: input.userId,
        project_id: existingRow?.project_id ?? null,
        title: parsed.title,
        details: parsed.details,
        start_at: parsed.startAt,
        end_at: parsed.endAt,
        timezone: parsed.timezone,
        source: existingRow?.source ?? "google",
        calendar_provider: "google",
        provider_event_id: event.id,
        provider_event_url: parsed.providerEventUrl,
        provider_status: parsed.providerStatus,
        is_all_day: parsed.isAllDay,
        archived_at: null
      };
    })
    .filter(Boolean);

  if (upserts.length > 0) {
    const { error } = await supabase.from("calendar_blocks").upsert(upserts, { onConflict: "user_id,calendar_provider,provider_event_id" });
    if (error) throw error;
  }

  const synced = await selectBlocksByProviderIds(supabase, input.userId, providerIds);
  return synced.sort((a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime());
}

export async function listLocalCalendarBlocks(input: {
  userId: string;
  timeMin: string;
  timeMax: string;
}): Promise<CalendarBlockRow[]> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("calendar_blocks")
    .select("id, user_id, project_id, title, details, start_at, end_at, timezone, source, calendar_provider, provider_event_id, provider_event_url, provider_status, is_all_day, archived_at")
    .eq("user_id", input.userId)
    .is("archived_at", null)
    .gte("end_at", input.timeMin)
    .lte("start_at", input.timeMax)
    .order("start_at", { ascending: true });
  if (error) throw error;
  return (data as CalendarBlockRow[] | null) ?? [];
}

export async function getCalendarBlockById(userId: string, id: string): Promise<CalendarBlockRow | null> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("calendar_blocks")
    .select("id, user_id, project_id, title, details, start_at, end_at, timezone, source, calendar_provider, provider_event_id, provider_event_url, provider_status, is_all_day, archived_at")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return (data as CalendarBlockRow | null) ?? null;
}

export async function upsertCalendarBlock(input: { userId: string; blockId?: string | null; payload: CalendarBlockInput }): Promise<CalendarBlockRow> {
  const supabase = createAdminClient();
  const timezone = normalizeTimezone(input.payload.timezone ?? null);

  if (input.blockId) {
    const existing = await getCalendarBlockById(input.userId, input.blockId);
    if (!existing) throw new Error("calendar_block_not_found");
    if (existing.is_all_day) throw new Error("calendar_block_all_day_read_only");

    let remote: { id: string; htmlLink: string | null; status: string | null };
    try {
      remote = await updateGoogleEvent(input.userId, existing.provider_event_id ?? "", toGooglePayload({ ...input.payload, timezone }));
    } catch (error) {
      if (error instanceof Error && error.message === "calendar_event_not_found") {
        remote = await createGoogleEvent(input.userId, toGooglePayload({ ...input.payload, timezone }));
      } else {
        throw error;
      }
    }

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
        provider_event_id: remote.id,
        provider_event_url: remote.htmlLink,
        provider_status: remote.status,
        archived_at: null
      })
      .eq("id", existing.id)
      .eq("user_id", input.userId)
      .select("id, user_id, project_id, title, details, start_at, end_at, timezone, source, calendar_provider, provider_event_id, provider_event_url, provider_status, is_all_day, archived_at")
      .single();

    if (error) throw error;
    return data as CalendarBlockRow;
  }

  const remote = await createGoogleEvent(input.userId, toGooglePayload({ ...input.payload, timezone }));
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
      provider_event_id: remote.id,
      provider_event_url: remote.htmlLink,
      provider_status: remote.status,
      is_all_day: false
    })
    .select("id, user_id, project_id, title, details, start_at, end_at, timezone, source, calendar_provider, provider_event_id, provider_event_url, provider_status, is_all_day, archived_at")
    .single();
  if (error) throw error;
  return data as CalendarBlockRow;
}

export async function deleteCalendarBlock(input: { userId: string; blockId: string }): Promise<void> {
  const supabase = createAdminClient();
  const existing = await getCalendarBlockById(input.userId, input.blockId);
  if (!existing) throw new Error("calendar_block_not_found");
  if (existing.provider_event_id) {
    await deleteGoogleEvent(input.userId, existing.provider_event_id);
  }
  const { error } = await supabase.from("calendar_blocks").delete().eq("id", existing.id).eq("user_id", input.userId);
  if (error) throw error;
}

