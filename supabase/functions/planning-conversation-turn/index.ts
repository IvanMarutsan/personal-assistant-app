import { DateTime } from "npm:luxon@3.6.1";
import { createAdminClient } from "../_shared/db.ts";
import { handleOptions, jsonResponse, safeJson } from "../_shared/http.ts";
import {
  buildPlanningDayContext,
  ensurePlanningSession,
  loadPlanningConversationState,
  normalizeTaskPatchPayload,
  type PlanningConversationMessage,
  type PlanningConversationTask,
  type TaskPatchPayload,
  validateScopeDate
} from "../_shared/planning-conversation.ts";
import { resolveSessionUser } from "../_shared/session.ts";

type TurnBody = {
  scopeDate?: string;
  sessionId?: string;
  message?: string;
};

type RawAiProposal = {
  task_id?: string;
  proposal_type?: "task_patch";
  rationale?: string;
  payload?: TaskPatchPayload;
};

type AiTurnPayload = {
  assistant_text?: string;
  proposals?: RawAiProposal[];
};

type ParsedProposal = {
  taskId: string;
  proposalType: "task_patch";
  rationale: string | null;
  payload: TaskPatchPayload;
};
function hasUkrainianSignal(text: string | null | undefined): boolean {
  if (!text) return false;
  return /[?-??-?????????]/.test(text);
}

function parseAiPayload(raw: string): AiTurnPayload | null {
  try {
    const parsed = JSON.parse(raw) as AiTurnPayload;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.assistant_text !== "string") return null;
    if (!Array.isArray(parsed.proposals)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function toPromptTask(task: PlanningConversationTask) {
  return {
    id: task.id,
    title: task.title,
    project: task.projectName,
    status: task.status,
    taskType: task.taskType,
    importance: task.importance,
    isProtectedEssential: task.isProtectedEssential,
    scheduledFor: task.scheduledFor,
    dueAt: task.dueAt,
    estimatedMinutes: task.estimatedMinutes
  };
}

function formatHistory(messages: PlanningConversationMessage[]): string {
  const relevant = messages.slice(-10);
  if (relevant.length === 0) return "Історія порожня.";
  return relevant
    .map((message) => `${message.role === "user" ? "Користувач" : "Асистент"}: ${message.content}`)
    .join("\n");
}

function normalizeAiProposals(raw: RawAiProposal[], allowedTaskIds: Set<string>): ParsedProposal[] {
  const result: ParsedProposal[] = [];
  const seenTaskIds = new Set<string>();

  for (const item of raw) {
    if (!item || item.proposal_type !== "task_patch" || typeof item.task_id !== "string") continue;
    if (!allowedTaskIds.has(item.task_id) || seenTaskIds.has(item.task_id)) continue;
    const payload = normalizeTaskPatchPayload(item.payload);
    if (!payload) continue;
    seenTaskIds.add(item.task_id);
    const rationale = typeof item.rationale === "string" && item.rationale.trim() ? item.rationale.trim() : null;
    result.push({
      taskId: item.task_id,
      proposalType: "task_patch",
      rationale: rationale && hasUkrainianSignal(rationale) ? rationale : null,
      payload
    });
  }

  return result;
}

async function generateAiTurn(input: {
  apiKey: string;
  model: string;
  scopeDate: string;
  timezone: string;
  currentTimeIso: string;
  history: PlanningConversationMessage[];
  context: Awaited<ReturnType<typeof buildPlanningDayContext>>;
}): Promise<{ assistantText: string; proposals: ParsedProposal[] } | null> {
  const relevantTasks = [
    ...input.context.scheduledToday,
    ...input.context.dueTodayWithoutPlannedStart,
    ...input.context.relevantBacklog
  ];
  const allowedTaskIds = new Set(relevantTasks.map((task) => task.id));

  const requestBody = {
    model: input.model,
    temperature: 0.3,
    messages: [
      {
        role: "system",
        content:
          "Ти помічник денного планування в українськомовному mini app. Ти не застосовуєш зміни самостійно, а лише пропонуєш вузькі task_patch зміни. Backlog = scheduled_for IS NULL. due_at без scheduled_for не означає, що задача вже стоїть у денному плані. Відповідай українською коротко і практично. Пропозиції можуть змінювати тільки scheduled_for, due_at, estimated_minutes. Дозволено очищати scheduled_for, щоб повернути задачу в беклог. Якщо користувач просить перенести задачу на інший день без конкретного часу, використай 09:00 локального часу цього дня. Не придумуй задачі, яких немає в контексті. Якщо пропонувати нічого, поверни порожній список proposals."
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            scopeType: "day",
            scopeDate: input.scopeDate,
            timezone: input.timezone,
            currentLocalTime: input.currentTimeIso,
            daySummary: {
              plannedTodayCount: input.context.plannedTodayCount,
              dueTodayWithoutPlannedStartCount: input.context.dueTodayWithoutPlannedStartCount,
              backlogCount: input.context.backlogCount,
              scheduledKnownEstimateMinutes: input.context.scheduledKnownEstimateMinutes,
              scheduledMissingEstimateCount: input.context.scheduledMissingEstimateCount
            },
            tasks: {
              scheduledToday: input.context.scheduledToday.map(toPromptTask),
              dueTodayWithoutPlannedStart: input.context.dueTodayWithoutPlannedStart.map(toPromptTask),
              relevantBacklog: input.context.relevantBacklog.map(toPromptTask)
            },
            conversationHistory: formatHistory(input.history),
            outputRules: {
              assistant_text: "Стислий людський коментар українською.",
              proposals: [
                {
                  proposal_type: "task_patch",
                  task_id: "один із task ids з контексту",
                  rationale: "чому саме ця зміна доречна",
                  payload: {
                    scheduled_for: "ISO-рядок або null",
                    due_at: "ISO-рядок або null",
                    estimated_minutes: "додатне ціле число або null"
                  }
                }
              ]
            }
          },
          null,
          2
        )
      }
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "planning_conversation_turn",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            assistant_text: { type: "string" },
            proposals: {
              type: "array",
              maxItems: 8,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  task_id: { type: "string" },
                  proposal_type: { type: "string", enum: ["task_patch"] },
                  rationale: { type: "string" },
                  payload: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      scheduled_for: { type: ["string", "null"] },
                      due_at: { type: ["string", "null"] },
                      estimated_minutes: { type: ["integer", "null"] }
                    }
                  }
                },
                required: ["task_id", "proposal_type", "rationale", "payload"]
              }
            }
          },
          required: ["assistant_text", "proposals"]
        }
      }
    }
  };

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${input.apiKey}`
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) return null;

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const raw = payload.choices?.[0]?.message?.content;
  if (!raw) return null;

  const parsed = parseAiPayload(raw);
  if (!parsed) return null;

  return {
    assistantText: parsed.assistant_text?.trim() || "Я не бачу достатньо підстав для конкретних змін у плані на цей день.",
    proposals: normalizeAiProposals(parsed.proposals ?? [], allowedTaskIds)
  };
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

  const body = await safeJson<TurnBody>(req);
  const scopeDate = validateScopeDate(body?.scopeDate);
  const userMessage = body?.message?.trim();

  if (!scopeDate) {
    return jsonResponse({ ok: false, error: "invalid_scope_date" }, 400);
  }
  if (!userMessage) {
    return jsonResponse({ ok: false, error: "missing_message" }, 400);
  }

  try {
    const supabase = createAdminClient();
    const session = await ensurePlanningSession(supabase, sessionUser.userId, scopeDate);
    if (body?.sessionId && body.sessionId !== session.id) {
      return jsonResponse({ ok: false, error: "invalid_session_id" }, 400);
    }

    const { data: insertedUserMessage, error: userMessageError } = await supabase
      .from("planning_messages")
      .insert({
        session_id: session.id,
        role: "user",
        content: userMessage
      })
      .select("id")
      .single();

    if (userMessageError || !insertedUserMessage) {
      return jsonResponse({ ok: false, error: "planning_message_create_failed" }, 500);
    }

    const context = await buildPlanningDayContext(supabase, sessionUser.userId, scopeDate);
    const { data: historyData, error: historyError } = await supabase
      .from("planning_messages")
      .select("id, session_id, role, content, created_at")
      .eq("session_id", session.id)
      .order("created_at", { ascending: true })
      .limit(40);

    if (historyError) {
      return jsonResponse({ ok: false, error: "planning_history_fetch_failed" }, 500);
    }

    const openAiApiKey = Deno.env.get("OPENAI_API_KEY");
    const model = Deno.env.get("OPENAI_MODEL") ?? "gpt-4.1-mini";
    let assistantText = "Зараз не вдалося зібрати AI-пропозиції. Можеш уточнити, що саме перенести або що точно лишити на сьогодні.";
    let proposals: ParsedProposal[] = [];

    if (openAiApiKey) {
      const aiTurn = await generateAiTurn({
        apiKey: openAiApiKey,
        model,
        scopeDate,
        timezone: context.timezone,
        currentTimeIso: DateTime.now().setZone(context.timezone).toISO() ?? new Date().toISOString(),
        history: (historyData ?? []) as PlanningConversationMessage[],
        context
      });

      if (aiTurn) {
        assistantText = aiTurn.assistantText;
        proposals = aiTurn.proposals;
      }
    }

    const { error: supersedeError } = await supabase
      .from("planning_proposals")
      .update({ status: "superseded" })
      .eq("session_id", session.id)
      .eq("status", "proposed");

    if (supersedeError) {
      return jsonResponse({ ok: false, error: "planning_supersede_failed" }, 500);
    }

    const { data: assistantMessage, error: assistantError } = await supabase
      .from("planning_messages")
      .insert({
        session_id: session.id,
        role: "assistant",
        content: assistantText
      })
      .select("id")
      .single();

    if (assistantError || !assistantMessage) {
      return jsonResponse({ ok: false, error: "planning_assistant_message_create_failed" }, 500);
    }

    if (proposals.length > 0) {
      const proposalRows = proposals.map((proposal) => ({
        session_id: session.id,
        assistant_message_id: assistantMessage.id,
        task_id: proposal.taskId,
        proposal_type: proposal.proposalType,
        payload: proposal.payload,
        rationale: proposal.rationale,
        status: "proposed"
      }));

      const { error: proposalsError } = await supabase.from("planning_proposals").insert(proposalRows);
      if (proposalsError) {
        return jsonResponse({ ok: false, error: "planning_proposals_create_failed" }, 500);
      }
    }

    const state = await loadPlanningConversationState(supabase, sessionUser.userId, scopeDate);
    return jsonResponse({ ok: true, ...state });
  } catch (error) {
    return jsonResponse(
      {
        ok: false,
        error: "planning_turn_failed",
        message: error instanceof Error ? error.message : "unknown_error"
      },
      500
    );
  }
});

