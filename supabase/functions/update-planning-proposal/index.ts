import { createAdminClient } from "../_shared/db.ts";
import { handleOptions, jsonResponse, safeJson } from "../_shared/http.ts";
import {
  getLatestActionableAssistantMessageId,
  loadPlanningConversationState,
  normalizeTaskPatchPayload,
  type TaskPatchPayload
} from "../_shared/planning-conversation.ts";
import { resolveSessionUser } from "../_shared/session.ts";
import { syncTaskCalendarAfterMutation } from "../_shared/task-calendar-sync.ts";

type ProposalActionBody = {
  proposalId?: string;
  assistantMessageId?: string;
  action?: "apply" | "dismiss" | "apply_all_latest" | "dismiss_all_latest";
};

type ProposalRow = {
  id: string;
  session_id: string;
  assistant_message_id: string | null;
  task_id: string;
  payload: unknown;
  status: "proposed" | "applied" | "dismissed" | "superseded";
  created_at: string;
};

type TaskRow = {
  id: string;
  user_id: string;
  title: string;
  details: string | null;
  task_type:
    | "deep_work"
    | "quick_communication"
    | "admin_operational"
    | "recurring_essential"
    | "personal_essential"
    | "someday";
  project_id: string | null;
  due_at: string | null;
  scheduled_for: string | null;
  estimated_minutes: number | null;
};

function buildTaskUpdatePayload(task: TaskRow, patch: TaskPatchPayload): Record<string, unknown> {
  const updatePayload: Record<string, unknown> = {
    title: task.title,
    details: task.details,
    task_type: task.task_type
  };

  if (Object.prototype.hasOwnProperty.call(patch, "scheduled_for")) {
    updatePayload.scheduled_for = patch.scheduled_for;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "due_at")) {
    updatePayload.due_at = patch.due_at;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "estimated_minutes")) {
    updatePayload.estimated_minutes = patch.estimated_minutes;
  }

  return updatePayload;
}

async function loadSessionProposals(supabase: ReturnType<typeof createAdminClient>, sessionId: string): Promise<ProposalRow[]> {
  const { data, error } = await supabase
    .from("planning_proposals")
    .select("id, session_id, assistant_message_id, task_id, payload, status, created_at")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true });

  if (error) throw error;
  return (data ?? []) as ProposalRow[];
}

async function applyProposalRows(
  supabase: ReturnType<typeof createAdminClient>,
  userId: string,
  proposals: ProposalRow[]
): Promise<Response | null> {
  const taskIds = [...new Set(proposals.map((proposal) => proposal.task_id))];
  const patches = new Map<string, TaskPatchPayload>();

  for (const proposal of proposals) {
    const patch = normalizeTaskPatchPayload(proposal.payload);
    if (!patch) {
      return jsonResponse({ ok: false, error: "invalid_proposal_payload" }, 400);
    }
    patches.set(proposal.id, patch);
  }

  const { data: tasks, error: tasksError } = await supabase
    .from("tasks")
    .select("id, user_id, title, details, task_type, project_id, due_at, scheduled_for, estimated_minutes")
    .eq("user_id", userId)
    .in("id", taskIds);

  if (tasksError) {
    return jsonResponse({ ok: false, error: "task_not_found" }, 404);
  }

  const taskMap = new Map((tasks ?? []).map((task) => [task.id as string, task as TaskRow]));
  if (taskMap.size !== taskIds.length) {
    return jsonResponse({ ok: false, error: "task_not_found" }, 404);
  }

  for (const proposal of proposals) {
    const task = taskMap.get(proposal.task_id);
    const patch = patches.get(proposal.id);
    if (!task || !patch) {
      return jsonResponse({ ok: false, error: "task_not_found" }, 404);
    }

    const { error: updateError } = await supabase
      .from("tasks")
      .update(buildTaskUpdatePayload(task, patch))
      .eq("id", proposal.task_id)
      .eq("user_id", userId);

    if (updateError) {
      return jsonResponse({ ok: false, error: "proposal_apply_failed", message: updateError.message }, 500);
    }

    await syncTaskCalendarAfterMutation(supabase, userId, proposal.task_id);
  }

  const { error: applyError } = await supabase
    .from("planning_proposals")
    .update({ status: "applied" })
    .in("id", proposals.map((proposal) => proposal.id));

  if (applyError) {
    return jsonResponse({ ok: false, error: "proposal_apply_state_failed" }, 500);
  }

  return null;
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

  const body = await safeJson<ProposalActionBody>(req);
  if (!body?.action) {
    return jsonResponse({ ok: false, error: "invalid_request" }, 400);
  }

  try {
    const supabase = createAdminClient();

    if (body.action === "apply" || body.action === "dismiss") {
      if (!body.proposalId) {
        return jsonResponse({ ok: false, error: "invalid_request" }, 400);
      }

      const { data: proposal, error: proposalError } = await supabase
        .from("planning_proposals")
        .select("id, session_id, assistant_message_id, task_id, payload, status, created_at")
        .eq("id", body.proposalId)
        .maybeSingle();

      if (proposalError || !proposal) {
        return jsonResponse({ ok: false, error: "proposal_not_found" }, 404);
      }

      const proposalRow = proposal as ProposalRow;

      const { data: session, error: sessionError } = await supabase
        .from("planning_sessions")
        .select("id, user_id, scope_type, scope_date")
        .eq("id", proposalRow.session_id)
        .eq("user_id", sessionUser.userId)
        .maybeSingle();

      if (sessionError || !session) {
        return jsonResponse({ ok: false, error: "proposal_not_found" }, 404);
      }

      if (proposalRow.status !== "proposed") {
        return jsonResponse({ ok: false, error: "proposal_not_actionable" }, 409);
      }

      if (body.action === "dismiss") {
        const { error: dismissError } = await supabase
          .from("planning_proposals")
          .update({ status: "dismissed" })
          .eq("id", proposalRow.id);

        if (dismissError) {
          return jsonResponse({ ok: false, error: "proposal_dismiss_failed" }, 500);
        }

        const state = await loadPlanningConversationState(
          supabase,
          sessionUser.userId,
          (session.scope_type as "day" | "week") ?? "day",
          session.scope_date as string
        );
        return jsonResponse({ ok: true, ...state });
      }

      const applyResponse = await applyProposalRows(supabase, sessionUser.userId, [proposalRow]);
      if (applyResponse) return applyResponse;

      const state = await loadPlanningConversationState(
        supabase,
        sessionUser.userId,
        (session.scope_type as "day" | "week") ?? "day",
        session.scope_date as string
      );
      return jsonResponse({ ok: true, ...state });
    }

    if (!body.assistantMessageId) {
      return jsonResponse({ ok: false, error: "invalid_request" }, 400);
    }

    const { data: proposalSet, error: proposalSetError } = await supabase
      .from("planning_proposals")
      .select("id, session_id, assistant_message_id, task_id, payload, status, created_at")
      .eq("assistant_message_id", body.assistantMessageId)
      .order("created_at", { ascending: true });

    if (proposalSetError || !proposalSet || proposalSet.length === 0) {
      return jsonResponse({ ok: false, error: "proposal_set_not_found" }, 404);
    }

    const proposalRows = proposalSet as ProposalRow[];
    const sessionId = proposalRows[0]?.session_id;
    if (!sessionId) {
      return jsonResponse({ ok: false, error: "proposal_set_not_found" }, 404);
    }

    const { data: session, error: sessionError } = await supabase
      .from("planning_sessions")
      .select("id, user_id, scope_type, scope_date")
      .eq("id", sessionId)
      .eq("user_id", sessionUser.userId)
      .maybeSingle();

    if (sessionError || !session) {
      return jsonResponse({ ok: false, error: "proposal_set_not_found" }, 404);
    }

    const sessionProposals = await loadSessionProposals(supabase, sessionId);
    const latestActionableAssistantMessageId = getLatestActionableAssistantMessageId(sessionProposals);
    if (!latestActionableAssistantMessageId || latestActionableAssistantMessageId !== body.assistantMessageId) {
      return jsonResponse({ ok: false, error: "proposal_set_not_actionable" }, 409);
    }

    const activeSet = sessionProposals.filter(
      (proposal) =>
        proposal.status === "proposed" &&
        proposal.assistant_message_id === latestActionableAssistantMessageId
    );

    if (activeSet.length === 0) {
      return jsonResponse({ ok: false, error: "proposal_set_not_actionable" }, 409);
    }

    if (body.action === "dismiss_all_latest") {
      const { error: dismissError } = await supabase
        .from("planning_proposals")
        .update({ status: "dismissed" })
        .in("id", activeSet.map((proposal) => proposal.id));

      if (dismissError) {
        return jsonResponse({ ok: false, error: "proposal_dismiss_failed" }, 500);
      }

      const state = await loadPlanningConversationState(
        supabase,
        sessionUser.userId,
        (session.scope_type as "day" | "week") ?? "day",
        session.scope_date as string
      );
      return jsonResponse({ ok: true, ...state });
    }

    if (body.action !== "apply_all_latest") {
      return jsonResponse({ ok: false, error: "invalid_request" }, 400);
    }

    const applyResponse = await applyProposalRows(supabase, sessionUser.userId, activeSet);
    if (applyResponse) return applyResponse;

    const state = await loadPlanningConversationState(
      supabase,
      sessionUser.userId,
      (session.scope_type as "day" | "week") ?? "day",
      session.scope_date as string
    );
    return jsonResponse({ ok: true, ...state });
  } catch (error) {
    return jsonResponse(
      {
        ok: false,
        error: "planning_proposal_update_failed",
        message: error instanceof Error ? error.message : "unknown_error"
      },
      500
    );
  }
});
