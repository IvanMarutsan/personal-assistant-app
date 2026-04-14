import { createAdminClient } from "../_shared/db.ts";
import { handleOptions, jsonResponse, safeJson } from "../_shared/http.ts";
import { resolveSessionUser } from "../_shared/session.ts";
import { syncTaskGoogleAfterMutation } from "../_shared/task-google-sync.ts";
import { nextRecurringInstant, parseSupportedRecurrenceRule } from "../_shared/recurrence.ts";

type TaskStatus = "planned" | "in_progress" | "blocked" | "done" | "cancelled";

type UpdateTaskStatusBody = {
  taskId?: string;
  status?: TaskStatus;
  reasonCode?:
    | "reprioritized"
    | "blocked_dependency"
    | "urgent_interrupt"
    | "calendar_conflict"
    | "underestimated"
    | "low_energy"
    | "waiting_response"
    | "waiting_on_external"
    | "personal_issue"
    | "other";
  reasonText?: string;
  rescheduleTo?: string;
  dueAt?: string;
  postponeMinutes?: number;
};

function mapTaskError(message: string): { status: number; error: string } {
  if (message.includes("task_not_found")) return { status: 404, error: "task_not_found" };
  return { status: 500, error: "task_update_failed" };
}

function toIsoOrNull(value?: string): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function resolveEventHint(body: UpdateTaskStatusBody): "postponed" | "rescheduled" | null {
  if ((body.postponeMinutes ?? 0) > 0) return "postponed";
  if (body.rescheduleTo || body.dueAt) return "rescheduled";
  return null;
}

async function createNextRecurringTaskOccurrence(input: {
  supabase: ReturnType<typeof createAdminClient>;
  userId: string;
  task: {
    id: string;
    user_id: string;
    project_id: string | null;
    title: string;
    details: string | null;
    task_type: string;
    due_at: string | null;
    scheduled_for: string | null;
    estimated_minutes: number | null;
    planning_flexibility: string | null;
    is_protected_essential: boolean;
    recurrence_rule: string | null;
    recurrence_timezone: string | null;
    google_task_sync_mode: string | null;
  };
}): Promise<string | null> {
  const frequency = parseSupportedRecurrenceRule(input.task.recurrence_rule);
  if (!frequency) return null;

  const nextDueAt = nextRecurringInstant(input.task.due_at, frequency);
  const nextScheduledFor = nextRecurringInstant(input.task.scheduled_for, frequency);
  if (!nextDueAt && !nextScheduledFor) return null;

  const insertPayload: Record<string, unknown> = {
    user_id: input.userId,
    project_id: input.task.project_id,
    title: input.task.title,
    details: input.task.details,
    task_type: input.task.task_type,
    status: "planned",
    due_at: nextDueAt,
    scheduled_for: nextScheduledFor,
    estimated_minutes: input.task.estimated_minutes,
    planning_flexibility: input.task.planning_flexibility,
    is_protected_essential: input.task.is_protected_essential,
    is_recurring: true,
    recurrence_rule: input.task.recurrence_rule,
    recurrence_timezone: input.task.recurrence_timezone ?? "UTC",
    recurrence_origin_task_id: input.task.id
  };

  if (input.task.google_task_sync_mode === "manual") {
    insertPayload.google_task_sync_mode = "manual";
  }

  const { data, error } = await input.supabase.from("tasks").insert(insertPayload).select("id").single();
  if (error || !data) throw error ?? new Error("recurring_task_create_failed");

  try {
    if (input.task.google_task_sync_mode !== "manual") {
      await syncTaskGoogleAfterMutation(input.supabase, input.userId, data.id as string, { forceCreate: true });
    }
  } catch (googleTaskError) {
    console.error("[update-task-status] recurring_google_task_sync_failed", {
      taskId: data.id,
      userId: input.userId,
      error: googleTaskError
    });
  }

  return data.id as string;
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

  const body = await safeJson<UpdateTaskStatusBody>(req);
  if (!body?.taskId || !body.status) {
    return jsonResponse({ ok: false, error: "missing_fields" }, 400);
  }

  const eventHint = resolveEventHint(body);
  const newScheduledFor = toIsoOrNull(body.rescheduleTo);
  const newDueAt = toIsoOrNull(body.dueAt);

  if ((body.rescheduleTo && !newScheduledFor) || (body.dueAt && !newDueAt)) {
    return jsonResponse({ ok: false, error: "invalid_datetime" }, 400);
  }

  const supabase = createAdminClient();
  const { data: taskBeforeUpdate, error: loadError } = await supabase
    .from("tasks")
    .select("id, user_id, project_id, title, details, task_type, status, due_at, scheduled_for, estimated_minutes, planning_flexibility, is_protected_essential, is_recurring, recurrence_rule, recurrence_timezone, google_task_sync_mode")
    .eq("id", body.taskId)
    .eq("user_id", sessionUser.userId)
    .maybeSingle();

  if (loadError || !taskBeforeUpdate) {
    return jsonResponse({ ok: false, error: "task_not_found" }, 404);
  }

  const { data, error } = await supabase.rpc("update_task_status_atomic", {
    p_user_id: sessionUser.userId,
    p_task_id: body.taskId,
    p_new_status: body.status,
    p_reason_code: body.reasonCode ?? null,
    p_reason_text: body.reasonText ?? null,
    p_new_due_at: newDueAt,
    p_new_scheduled_for: newScheduledFor,
    p_event_hint: eventHint,
    p_postpone_minutes: body.postponeMinutes ?? null
  });

  if (error) {
    const mapped = mapTaskError(error.message);
    return jsonResponse({ ok: false, error: mapped.error, message: error.message }, mapped.status);
  }

  try {
    await syncTaskGoogleAfterMutation(supabase, sessionUser.userId, body.taskId);
  } catch (googleTaskError) {
    console.error("[update-task-status] google_task_sync_failed", {
      taskId: body.taskId,
      userId: sessionUser.userId,
      error: googleTaskError
    });
  }

  if (
    body.status === "done" &&
    taskBeforeUpdate.status !== "done" &&
    taskBeforeUpdate.is_recurring &&
    taskBeforeUpdate.recurrence_rule
  ) {
    await createNextRecurringTaskOccurrence({
      supabase,
      userId: sessionUser.userId,
      task: taskBeforeUpdate as {
        id: string;
        user_id: string;
        project_id: string | null;
        title: string;
        details: string | null;
        task_type: string;
        due_at: string | null;
        scheduled_for: string | null;
        estimated_minutes: number | null;
        planning_flexibility: string | null;
        is_protected_essential: boolean;
        recurrence_rule: string | null;
        recurrence_timezone: string | null;
        google_task_sync_mode: string | null;
      }
    });
  }

  return jsonResponse({ ok: true, result: data });
});

