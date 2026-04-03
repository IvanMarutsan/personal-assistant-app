import { createAdminClient } from "../_shared/db.ts";
import { getGoogleAccessTokenForUser } from "../_shared/google-calendar.ts";
import { handleOptions, jsonResponse, safeJson } from "../_shared/http.ts";
import { resolveSessionUser } from "../_shared/session.ts";

type CandidateStatus = "pending" | "confirmed" | "discarded";
type ResolveAction = "task" | "note" | "calendar_event" | "discard";

type VoiceCandidate = {
  candidateId: string;
  detectedIntent: "task" | "note" | "meeting_candidate" | "reminder_candidate";
  title: string;
  details: string;
  projectGuess: string | null;
  taskTypeGuess:
    | "deep_work"
    | "quick_communication"
    | "admin_operational"
    | "recurring_essential"
    | "personal_essential"
    | "someday"
    | null;
  importanceGuess: number | null;
  dueHint: string | null;
  datetimeHint: string | null;
  dueAtIso: string | null;
  scheduledForIso: string | null;
  confidence: number;
  reasoningSummary: string;
  status?: CandidateStatus;
  resolvedAt?: string | null;
  resolutionAction?: ResolveAction | null;
  resolution?: Record<string, unknown> | null;
};

type ResolveBody = {
  inboxItemId?: string;
  candidateId?: string;
  action?: ResolveAction;
  title?: string;
  details?: string;
  noteBody?: string;
  projectId?: string;
  taskType?:
    | "deep_work"
    | "quick_communication"
    | "admin_operational"
    | "recurring_essential"
    | "personal_essential"
    | "someday";
  importance?: number;
  dueAt?: string;
  scheduledFor?: string;
  timezone?: string;
};

function asIsoDateTime(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeCandidate(raw: unknown): VoiceCandidate | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.candidateId !== "string" || !raw.candidateId.trim()) return null;
  if (typeof raw.detectedIntent !== "string") return null;
  if (typeof raw.title !== "string") return null;
  if (typeof raw.details !== "string") return null;

  return {
    candidateId: raw.candidateId,
    detectedIntent: raw.detectedIntent as VoiceCandidate["detectedIntent"],
    title: raw.title,
    details: raw.details,
    projectGuess: typeof raw.projectGuess === "string" ? raw.projectGuess : null,
    taskTypeGuess: typeof raw.taskTypeGuess === "string" ? (raw.taskTypeGuess as VoiceCandidate["taskTypeGuess"]) : null,
    importanceGuess: typeof raw.importanceGuess === "number" ? raw.importanceGuess : null,
    dueHint: typeof raw.dueHint === "string" ? raw.dueHint : null,
    datetimeHint: typeof raw.datetimeHint === "string" ? raw.datetimeHint : null,
    dueAtIso: typeof raw.dueAtIso === "string" ? raw.dueAtIso : null,
    scheduledForIso: typeof raw.scheduledForIso === "string" ? raw.scheduledForIso : null,
    confidence: typeof raw.confidence === "number" ? raw.confidence : 0,
    reasoningSummary: typeof raw.reasoningSummary === "string" ? raw.reasoningSummary : "",
    status: raw.status === "confirmed" || raw.status === "discarded" ? raw.status : "pending",
    resolvedAt: typeof raw.resolvedAt === "string" ? raw.resolvedAt : null,
    resolutionAction:
      raw.resolutionAction === "task" ||
      raw.resolutionAction === "note" ||
      raw.resolutionAction === "calendar_event" ||
      raw.resolutionAction === "discard"
        ? raw.resolutionAction
        : null,
    resolution: isRecord(raw.resolution) ? raw.resolution : null
  };
}

function buildNoteBody(input: { title?: string; details?: string; noteBody?: string; fallback: string }): string {
  const explicit = input.noteBody?.trim();
  if (explicit) return explicit;

  const title = input.title?.trim() || "";
  const details = input.details?.trim() || "";
  if (title && details) return `${title}\n\n${details}`;
  if (title) return title;
  if (details) return details;
  return input.fallback;
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

  const body = await safeJson<ResolveBody>(req);
  if (!body?.inboxItemId || !body?.candidateId || !body?.action) {
    return jsonResponse({ ok: false, error: "missing_fields" }, 400);
  }

  const dueAt = body.dueAt ? asIsoDateTime(body.dueAt) : null;
  const scheduledFor = body.scheduledFor ? asIsoDateTime(body.scheduledFor) : null;

  if (body.dueAt && !dueAt) {
    return jsonResponse({ ok: false, error: "invalid_due_at" }, 400);
  }
  if (body.scheduledFor && !scheduledFor) {
    return jsonResponse({ ok: false, error: "invalid_scheduled_for" }, 400);
  }

  const supabase = createAdminClient();

  const { data: inbox, error: inboxError } = await supabase
    .from("inbox_items")
    .select("id, user_id, status, source_type, source_channel, project_id, transcript_text, meta")
    .eq("id", body.inboxItemId)
    .eq("user_id", sessionUser.userId)
    .maybeSingle();

  if (inboxError || !inbox) {
    return jsonResponse({ ok: false, error: "inbox_item_not_found" }, 404);
  }

  if (inbox.status !== "new") {
    return jsonResponse({ ok: false, error: "inbox_item_not_new" }, 409);
  }

  const meta = isRecord(inbox.meta) ? inbox.meta : {};
  const voiceAi = isRecord(meta.voice_ai) ? meta.voice_ai : {};
  const rawCandidates = Array.isArray(voiceAi.candidates) ? voiceAi.candidates : [];
  const candidates = rawCandidates.map(normalizeCandidate).filter((item): item is VoiceCandidate => Boolean(item));

  if (candidates.length === 0) {
    return jsonResponse({ ok: false, error: "voice_candidates_not_found" }, 400);
  }

  const candidateIndex = candidates.findIndex((item) => item.candidateId === body.candidateId);
  if (candidateIndex < 0) {
    return jsonResponse({ ok: false, error: "candidate_not_found" }, 404);
  }

  const candidate = candidates[candidateIndex];
  if ((candidate.status ?? "pending") !== "pending") {
    return jsonResponse({ ok: false, error: "candidate_already_processed" }, 409);
  }

  const nowIso = new Date().toISOString();
  let resolution: Record<string, unknown> = {};

  if (body.action === "task") {
    const taskTitle = (body.title?.trim() || candidate.title || "Untitled task").slice(0, 160);
    const details = body.details?.trim() || candidate.details || null;

    if (body.projectId) {
      const { data: project } = await supabase
        .from("projects")
        .select("id")
        .eq("id", body.projectId)
        .eq("user_id", sessionUser.userId)
        .maybeSingle();
      if (!project) return jsonResponse({ ok: false, error: "project_not_found" }, 400);
    }

    const importance =
      typeof body.importance === "number"
        ? Math.max(1, Math.min(5, Math.round(body.importance)))
        : typeof candidate.importanceGuess === "number"
        ? Math.max(1, Math.min(5, Math.round(candidate.importanceGuess)))
        : 3;

    const taskType = body.taskType ?? candidate.taskTypeGuess ?? "admin_operational";

    const { data: createdTask, error: taskError } = await supabase
      .from("tasks")
      .insert({
        user_id: sessionUser.userId,
        project_id: body.projectId ?? inbox.project_id ?? null,
        created_from_inbox_item_id: inbox.id,
        title: taskTitle,
        details,
        task_type: taskType,
        status: "planned",
        importance,
        due_at: dueAt ?? candidate.dueAtIso ?? null,
        scheduled_for: scheduledFor ?? candidate.scheduledForIso ?? null
      })
      .select("id")
      .single();

    if (taskError || !createdTask) {
      return jsonResponse({ ok: false, error: "task_create_failed" }, 500);
    }

    await supabase.from("task_events").insert({
      task_id: createdTask.id,
      user_id: sessionUser.userId,
      event_type: "triaged_from_inbox",
      payload: {
        source: "voice_multi_candidate",
        inbox_item_id: inbox.id,
        candidate_id: candidate.candidateId,
        detected_intent: candidate.detectedIntent
      }
    });

    resolution = { taskId: createdTask.id };
  } else if (body.action === "note") {
    const noteBody = buildNoteBody({
      title: body.title ?? candidate.title,
      details: body.details ?? candidate.details,
      noteBody: body.noteBody,
      fallback: inbox.transcript_text ?? "Нотатка без тексту"
    });

    const { data: createdNote, error: noteError } = await supabase
      .from("notes")
      .insert({
        user_id: sessionUser.userId,
        project_id: body.projectId ?? inbox.project_id ?? null,
        title: (body.title?.trim() || candidate.title || null) ?? null,
        body: noteBody,
        source_type: inbox.source_type,
        source_channel: inbox.source_channel
      })
      .select("id")
      .single();

    if (noteError || !createdNote) {
      return jsonResponse({ ok: false, error: "note_create_failed" }, 500);
    }

    resolution = { noteId: createdNote.id };
  } else if (body.action === "calendar_event") {
    const title = (body.title?.trim() || candidate.title || "Подія з голосового")?.slice(0, 180);
    const startAt = scheduledFor ?? candidate.scheduledForIso;
    const endAt = dueAt ?? candidate.dueAtIso ?? null;

    if (!startAt) {
      return jsonResponse({ ok: false, error: "missing_or_invalid_start" }, 400);
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("timezone")
      .eq("user_id", sessionUser.userId)
      .maybeSingle();

    const timezone = normalizeTimezone(body.timezone ?? ((profile?.timezone as string | null | undefined) ?? null));
    const auth = await getGoogleAccessTokenForUser(sessionUser.userId);

    const response = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(auth.calendarId)}/events`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${auth.accessToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          summary: title,
          description: body.details?.trim() || candidate.details || undefined,
          start: { dateTime: startAt, timeZone: timezone },
          end: {
            dateTime: endAt ?? new Date(new Date(startAt).getTime() + 30 * 60_000).toISOString(),
            timeZone: timezone
          }
        })
      }
    );

    const eventPayload = (await response.json().catch(() => null)) as
      | { id?: string; htmlLink?: string; status?: string }
      | null;
    if (!response.ok || !eventPayload?.id) {
      return jsonResponse({ ok: false, error: "calendar_event_create_failed" }, 502);
    }

    await supabase.from("calendar_event_links").insert({
      user_id: sessionUser.userId,
      provider: "google",
      provider_event_id: eventPayload.id,
      inbox_item_id: inbox.id,
      title,
      starts_at: startAt,
      ends_at: endAt ?? new Date(new Date(startAt).getTime() + 30 * 60_000).toISOString(),
      timezone,
      provider_event_url: eventPayload.htmlLink ?? null
    });

    resolution = {
      calendarEventId: eventPayload.id,
      calendarEventUrl: eventPayload.htmlLink ?? null
    };
  }

  const updatedCandidates = [...candidates];
  updatedCandidates[candidateIndex] = {
    ...candidate,
    status: body.action === "discard" ? "discarded" : "confirmed",
    resolvedAt: nowIso,
    resolutionAction: body.action,
    resolution
  };

  const allProcessed = updatedCandidates.every((item) => (item.status ?? "pending") !== "pending");

  const nextVoiceAi = {
    ...voiceAi,
    mode: updatedCandidates.length > 1 ? "multi_item" : "single_item",
    candidates: updatedCandidates,
    candidateCountShown: updatedCandidates.length,
    parseSuggestion: updatedCandidates[0] ?? null
  };

  const nextMeta = {
    ...meta,
    voice_ai: nextVoiceAi
  };

  const updatePayload: Record<string, unknown> = {
    meta: nextMeta
  };

  if (allProcessed) {
    updatePayload.status = "triaged";
    updatePayload.triaged_at = nowIso;
  }

  const { error: updateError } = await supabase
    .from("inbox_items")
    .update(updatePayload)
    .eq("id", inbox.id)
    .eq("user_id", sessionUser.userId)
    .eq("status", "new");

  if (updateError) {
    return jsonResponse({ ok: false, error: "candidate_state_update_failed" }, 500);
  }

  return jsonResponse({
    ok: true,
    allProcessed,
    candidate: updatedCandidates[candidateIndex]
  });
});
