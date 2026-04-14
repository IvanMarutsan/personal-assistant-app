import { createAdminClient } from "../_shared/db.ts";
import { handleOptions, jsonResponse, safeJson } from "../_shared/http.ts";
import { resolveSessionUser } from "../_shared/session.ts";
import { syncTaskGoogleAfterMutation } from "../_shared/task-google-sync.ts";
import { buildSupportedRecurrenceRule, parseSupportedRecurrenceFrequency } from "../_shared/recurrence.ts";

type TaskType =
  | "communication"
  | "publishing"
  | "admin"
  | "planning"
  | "tech"
  | "content"
  | "meeting"
  | "review"
  | "deep_work"
  | "quick_communication"
  | "admin_operational"
  | "recurring_essential"
  | "personal_essential"
  | "someday";

type PlanningFlexibility = "essential" | "flexible";
type CreateTaskBody = {
  title?: string;
  details?: string | null;
  projectId?: string | null;
  taskType?: TaskType;
  dueAt?: string | null;
  scheduledFor?: string | null;
  estimatedMinutes?: number | null;
  planningFlexibility?: PlanningFlexibility | null;
  recurrenceFrequency?: string | null;
};

function toIsoOrNull(value: string | null | undefined): string | null {
  if (value === null) return null;
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
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

  const body = await safeJson<CreateTaskBody>(req);
  const title = body?.title?.trim();
  if (!title) {
    return jsonResponse({ ok: false, error: "missing_title" }, 400);
  }

  const dueAt = toIsoOrNull(body?.dueAt);
  const scheduledFor = toIsoOrNull(body?.scheduledFor);
  const recurrenceFrequency = parseSupportedRecurrenceFrequency(body?.recurrenceFrequency ?? null);
  const recurrenceRule = buildSupportedRecurrenceRule(recurrenceFrequency);

  if (body?.dueAt && dueAt === null) {
    return jsonResponse({ ok: false, error: "invalid_due_at" }, 400);
  }
  if (body?.scheduledFor && scheduledFor === null) {
    return jsonResponse({ ok: false, error: "invalid_scheduled_for" }, 400);
  }
  if (
    body?.estimatedMinutes !== undefined &&
    body.estimatedMinutes !== null &&
    (!Number.isInteger(body.estimatedMinutes) || body.estimatedMinutes <= 0)
  ) {
    return jsonResponse({ ok: false, error: "invalid_estimated_minutes" }, 400);
  }
  if (
    body?.planningFlexibility !== undefined &&
    body.planningFlexibility !== null &&
    body.planningFlexibility !== "essential" &&
    body.planningFlexibility !== "flexible"
  ) {
    return jsonResponse({ ok: false, error: "invalid_planning_flexibility" }, 400);
  }
  if (body?.recurrenceFrequency !== undefined && body?.recurrenceFrequency !== null && !recurrenceFrequency) {
    return jsonResponse({ ok: false, error: "invalid_recurrence_frequency" }, 400);
  }
  if (recurrenceRule && !scheduledFor && !dueAt) {
    return jsonResponse({ ok: false, error: "recurrence_requires_anchor" }, 400);
  }

  const supabase = createAdminClient();

  let projectId: string | null = null;
  if (body?.projectId) {
    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("id")
      .eq("id", body.projectId)
      .eq("user_id", sessionUser.userId)
      .maybeSingle();

    if (projectError || !project) {
      return jsonResponse({ ok: false, error: "project_not_found" }, 400);
    }
    projectId = project.id as string;
  }

  const { data, error } = await supabase
    .from("tasks")
    .insert({
      user_id: sessionUser.userId,
      project_id: projectId,
      title: title.slice(0, 120),
      details: body?.details?.trim() || null,
      task_type: body?.taskType ?? "admin",
      status: "planned",
      importance: 3,
      due_at: dueAt,
      scheduled_for: scheduledFor,
      estimated_minutes: body?.estimatedMinutes ?? null,
      planning_flexibility: body?.planningFlexibility ?? null,
      is_recurring: Boolean(recurrenceRule),
      recurrence_rule: recurrenceRule,
      recurrence_timezone: recurrenceRule ? "UTC" : null
    })
    .select("id")
    .single();

  if (error || !data) {
    return jsonResponse({ ok: false, error: "task_create_failed", message: error?.message ?? null }, 500);
  }

  try {
    await syncTaskGoogleAfterMutation(supabase, sessionUser.userId, data.id as string, { forceCreate: true });
  } catch (googleTaskError) {
    console.error("[create-task] google_task_sync_failed", {
      taskId: data.id,
      userId: sessionUser.userId,
      error: googleTaskError
    });
  }

  const { data: createdTask } = await supabase
    .from("tasks")
    .select("google_task_provider, google_task_list_id, google_task_id, google_task_sync_error")
    .eq("id", data.id)
    .eq("user_id", sessionUser.userId)
    .maybeSingle();

  const linkedGoogleTask = Boolean(
    createdTask?.google_task_provider === "google_tasks" &&
      createdTask?.google_task_list_id &&
      createdTask?.google_task_id
  );

  return jsonResponse({
    ok: true,
    taskId: data.id,
    googleTaskSyncError: createdTask?.google_task_sync_error ?? null,
    linkedGoogleTask,
    googleTaskSyncState: createdTask?.google_task_sync_error ? "sync_unavailable" : linkedGoogleTask ? "linked" : "not_linked"
  });
});


