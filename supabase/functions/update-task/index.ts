import { createAdminClient } from "../_shared/db.ts";
import { handleOptions, jsonResponse, safeJson } from "../_shared/http.ts";
import { resolveSessionUser } from "../_shared/session.ts";
import { syncTaskCalendarAfterMutation } from "../_shared/task-calendar-sync.ts";

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
type UpdateTaskBody = {
  taskId?: string;
  title?: string;
  details?: string | null;
  projectId?: string | null;
  taskType?: TaskType;
  dueAt?: string | null;
  scheduledFor?: string | null;
  estimatedMinutes?: number | null;
  planningFlexibility?: PlanningFlexibility | null;
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

  const body = await safeJson<UpdateTaskBody>(req);
  if (!body?.taskId) {
    return jsonResponse({ ok: false, error: "missing_task_id" }, 400);
  }

  const title = body.title?.trim();
  if (!title) {
    return jsonResponse({ ok: false, error: "missing_title" }, 400);
  }

  const dueAt = toIsoOrNull(body.dueAt);
  const scheduledFor = toIsoOrNull(body.scheduledFor);

  if (body.dueAt && dueAt === null) {
    return jsonResponse({ ok: false, error: "invalid_due_at" }, 400);
  }
  if (body.scheduledFor && scheduledFor === null) {
    return jsonResponse({ ok: false, error: "invalid_scheduled_for" }, 400);
  }
  if (
    body.estimatedMinutes !== undefined &&
    body.estimatedMinutes !== null &&
    (!Number.isInteger(body.estimatedMinutes) || body.estimatedMinutes <= 0)
  ) {
    return jsonResponse({ ok: false, error: "invalid_estimated_minutes" }, 400);
  }
  if (
    body.planningFlexibility !== undefined &&
    body.planningFlexibility !== null &&
    body.planningFlexibility !== "essential" &&
    body.planningFlexibility !== "flexible"
  ) {
    return jsonResponse({ ok: false, error: "invalid_planning_flexibility" }, 400);
  }

  const supabase = createAdminClient();

  const { data: task, error: taskError } = await supabase
    .from("tasks")
    .select("id, user_id")
    .eq("id", body.taskId)
    .eq("user_id", sessionUser.userId)
    .maybeSingle();

  if (taskError || !task) {
    return jsonResponse({ ok: false, error: "task_not_found" }, 404);
  }

  let projectId: string | null = null;
  if (body.projectId !== undefined) {
    if (body.projectId === null || body.projectId === "") {
      projectId = null;
    } else {
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
  }

  const updatePayload: Record<string, unknown> = {
    title,
    details: body.details?.trim() || null,
    task_type: body.taskType
  };

  if (body.projectId !== undefined) {
    updatePayload.project_id = projectId;
  }
  if (body.dueAt !== undefined) {
    updatePayload.due_at = dueAt;
  }
  if (body.scheduledFor !== undefined) {
    updatePayload.scheduled_for = scheduledFor;
  }
  if (body.estimatedMinutes !== undefined) {
    updatePayload.estimated_minutes = body.estimatedMinutes;
  }
  if (body.planningFlexibility !== undefined) {
    updatePayload.planning_flexibility = body.planningFlexibility;
  }

  const { error: updateError } = await supabase
    .from("tasks")
    .update(updatePayload)
    .eq("id", body.taskId)
    .eq("user_id", sessionUser.userId);

  if (updateError) {
    return jsonResponse({ ok: false, error: "task_update_failed", message: updateError.message }, 500);
  }

  await syncTaskCalendarAfterMutation(supabase, sessionUser.userId, body.taskId);

  return jsonResponse({ ok: true, taskId: body.taskId });
});

