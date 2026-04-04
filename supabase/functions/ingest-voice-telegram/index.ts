import { createAdminClient } from "../_shared/db.ts";
import { handleOptions, jsonResponse, safeJson } from "../_shared/http.ts";

type IngestVoiceBody = {
  telegramUserId?: number;
  voiceFileId?: string;
  telegramChatId?: number;
  telegramMessageId?: number;
  voiceDurationSec?: number;
  voiceMimeType?: string;
  voiceFileSize?: number;
};

type VoiceIntent = "task" | "note" | "worklog_candidate" | "meeting_candidate" | "reminder_candidate";
type VoiceTaskTypeGuess =
  | "deep_work"
  | "quick_communication"
  | "admin_operational"
  | "recurring_essential"
  | "personal_essential"
  | "someday"
  | null;

type VoiceParseSuggestion = {
  detectedIntent: VoiceIntent;
  title: string;
  details: string;
  projectGuess: string | null;
  taskTypeGuess: VoiceTaskTypeGuess;
  importanceGuess: number | null;
  dueHint: string | null;
  datetimeHint: string | null;
  dueAtIso: string | null;
  scheduledForIso: string | null;
  confidence: number;
  reasoningSummary: string;
  candidateId?: string;
  status?: "pending" | "confirmed" | "discarded";
  resolvedAt?: string | null;
  resolutionAction?: "task" | "note" | "calendar_event" | "discard" | null;
};

type VoiceParsePayload = {
  mode: "single_item" | "multi_item";
  candidates: VoiceParseSuggestion[];
  candidateCountEstimated: number | null;
};

type ProjectMatch = {
  status: "matched" | "suggested_only" | "none";
  guessedName: string | null;
  matchedProjectId: string | null;
  matchedProjectName: string | null;
  score: number | null;
  strategy: "exact_normalized" | "similarity" | null;
};

type TranscriptResult = {
  status: "ok" | "failed";
  text: string | null;
  language: string | null;
  provider: "openai" | "none";
  error: string | null;
};

type ParseResult =
  | {
      status: "ok";
      provider: "openai";
      payload: VoiceParsePayload;
      error: null;
    }
  | {
      status: "failed" | "skipped";
      provider: "openai" | "none";
      payload: null;
      error: string;
    };

type ParseContext = {
  timezone: string;
  nowIsoUtc: string;
};

function unauthorized() {
  return jsonResponse({ ok: false, error: "unauthorized_bot_ingest" }, 401);
}

function cleanText(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function clampConfidence(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function normalizeImportance(value: unknown): number | null {
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  const rounded = Math.round(value);
  if (rounded < 1 || rounded > 5) return null;
  return rounded;
}

function normalizeTaskType(value: unknown): VoiceTaskTypeGuess {
  const allowed: Exclude<VoiceTaskTypeGuess, null>[] = [
    "deep_work",
    "quick_communication",
    "admin_operational",
    "recurring_essential",
    "personal_essential",
    "someday"
  ];
  if (value === null) return null;
  if (typeof value !== "string") return null;
  return allowed.includes(value as Exclude<VoiceTaskTypeGuess, null>)
    ? (value as Exclude<VoiceTaskTypeGuess, null>)
    : null;
}

function normalizeDateTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const asDate = new Date(trimmed);
  if (Number.isNaN(asDate.getTime())) return null;
  return asDate.toISOString();
}

function normalizeComparableText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasCyrillic(value: string): boolean {
  return /[\u0400-\u04FF]/.test(value);
}

function localizeReasoningSummary(
  raw: string | null,
  input: {
    intent: VoiceIntent;
    confidence: number;
    dueHint: string | null;
    datetimeHint: string | null;
  }
): string {
  const clean = cleanText(raw);
  if (clean && hasCyrillic(clean)) return clean;

  const intentText: Record<VoiceIntent, string> = {
    task: "Схоже на окрему задачу з голосового повідомлення.",
    note: "Схоже на нотатку без обов'язкової дії.",
    worklog_candidate: "Схоже на фактичний контекстний запис про те, що вже сталося.",
    meeting_candidate: "Схоже на запит або намір щодо зустрічі.",
    reminder_candidate: "Схоже на намір поставити нагадування."
  };
  const confidenceText =
    input.confidence >= 0.8 ? "Висока впевненість." : input.confidence >= 0.55 ? "Середня впевненість." : "Низька впевненість, перевір вручну.";
  const hint = cleanText(input.dueHint) ?? cleanText(input.datetimeHint);
  const timingText = hint ? `Часова підказка: ${hint}.` : "Явної часової підказки немає.";
  return `${intentText[input.intent]} ${timingText} ${confidenceText}`.trim();
}

function hasStrongSplitSignals(transcript: string): boolean {
  const text = transcript.toLowerCase();
  const markerMatch =
    /\b(перше|по[-\s]?перше|друге|по[-\s]?друге|третє|по[-\s]?третє|також|окремо|далі|потім|і ще|ще одне|1[).:-]|2[).:-]|3[).:-])\b/u.test(
      text
    );
  const sentenceLikeParts = text
    .split(/[.!?\n;]+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 18);
  return markerMatch || sentenceLikeParts.length >= 3;
}

function similarityScore(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const aTokens = new Set(a.split(" ").filter(Boolean));
  const bTokens = new Set(b.split(" ").filter(Boolean));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  let intersection = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) intersection += 1;
  }
  return (2 * intersection) / (aTokens.size + bTokens.size);
}

function shortText(value: string, limit = 280): string {
  if (!value) return "";
  return value.length <= limit ? value : `${value.slice(0, limit)}...`;
}

function normalizeTimezone(value: string | null | undefined): string {
  const candidate = value?.trim();
  if (!candidate) return "UTC";
  try {
    // Validate timezone string before using it in prompts or payloads.
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return "UTC";
  }
}

async function fetchTelegramVoiceBytes(voiceFileId: string): Promise<{
  ok: true;
  bytes: Uint8Array;
  mimeType: string;
  filePath: string;
} | {
  ok: false;
  error: string;
}> {
  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
  if (!botToken) {
    return { ok: false, error: "telegram_bot_token_missing" };
  }
  try {
    const fileMetaUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(voiceFileId)}`;

    const fileMetaResponse = await fetch(fileMetaUrl);
    if (!fileMetaResponse.ok) {
      return { ok: false, error: "telegram_get_file_failed" };
    }

    const fileMetaBody = (await fileMetaResponse.json()) as {
      ok?: boolean;
      result?: { file_path?: string };
    };

    const filePath = fileMetaBody.result?.file_path;
    if (!fileMetaBody.ok || !filePath) {
      return { ok: false, error: "telegram_file_path_missing" };
    }

    const fileDownloadUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
    const fileResponse = await fetch(fileDownloadUrl);
    if (!fileResponse.ok) {
      return { ok: false, error: "telegram_file_download_failed" };
    }

    const arrayBuffer = await fileResponse.arrayBuffer();
    const mimeType = fileResponse.headers.get("content-type") ?? "audio/ogg";

    return {
      ok: true,
      bytes: new Uint8Array(arrayBuffer),
      mimeType,
      filePath
    };
  } catch (error) {
    console.error("[ingest-voice-telegram] telegram_fetch_exception", {
      voiceFileId,
      error: error instanceof Error ? error.message : "unknown_error"
    });
    return { ok: false, error: "telegram_fetch_exception" };
  }
}

async function transcribeVoice(bytes: Uint8Array, mimeType: string): Promise<TranscriptResult> {
  const openAiApiKey = Deno.env.get("OPENAI_API_KEY");
  if (!openAiApiKey) {
    return {
      status: "failed",
      text: null,
      language: null,
      provider: "none",
      error: "openai_not_configured"
    };
  }

  const model = Deno.env.get("OPENAI_TRANSCRIBE_MODEL") ?? "gpt-4o-mini-transcribe";
  const formData = new FormData();
  formData.append("model", model);
  formData.append("language", "uk");
  formData.append("response_format", "json");
  formData.append("file", new File([bytes], "voice-message.ogg", { type: mimeType }));

  try {
    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${openAiApiKey}`
      },
      body: formData
    });

    if (!response.ok) {
      const errorText = shortText(await response.text());
      console.error("[ingest-voice-telegram] transcription_request_failed", {
        status: response.status,
        model,
        body: errorText
      });
      return {
        status: "failed",
        text: null,
        language: null,
        provider: "openai",
        error: `transcription_request_failed:${response.status}:${errorText || "no_body"}`
      };
    }

    const payload = (await response.json()) as {
      text?: string;
      language?: string;
    };

    const text = cleanText(payload.text);
    if (!text) {
      return {
        status: "failed",
        text: null,
        language: payload.language ?? null,
        provider: "openai",
        error: "empty_transcription"
      };
    }

    return {
      status: "ok",
      text,
      language: payload.language ?? null,
      provider: "openai",
      error: null
    };
  } catch (error) {
    console.error("[ingest-voice-telegram] transcription_exception", {
      model,
      error: error instanceof Error ? error.message : "unknown_error"
    });
    return {
      status: "failed",
      text: null,
      language: null,
      provider: "openai",
      error: "transcription_exception"
    };
  }
}

function normalizeCandidate(raw: unknown): VoiceParseSuggestion | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const parsed = raw as {
    detectedIntent: VoiceIntent;
    title: string;
    details: string;
    projectGuess: string | null;
    taskTypeGuess: VoiceTaskTypeGuess;
    importanceGuess: number | null;
    dueHint: string | null;
    datetimeHint: string | null;
    dueAtIso: string | null;
    scheduledForIso: string | null;
    confidence: number;
    reasoningSummary: string;
  };

  if (
    typeof parsed.detectedIntent !== "string" ||
    typeof parsed.title !== "string" ||
    typeof parsed.details !== "string" ||
    typeof parsed.confidence !== "number" ||
    typeof parsed.reasoningSummary !== "string"
  ) {
    return null;
  }

  const allowedIntents: VoiceIntent[] = ["task", "note", "worklog_candidate", "meeting_candidate", "reminder_candidate"];
  if (!allowedIntents.includes(parsed.detectedIntent)) return null;

  return {
    detectedIntent: parsed.detectedIntent,
    title: cleanText(parsed.title) ?? "Без назви",
    details: cleanText(parsed.details) ?? "",
    projectGuess: cleanText(parsed.projectGuess),
    taskTypeGuess: normalizeTaskType(parsed.taskTypeGuess),
    importanceGuess: normalizeImportance(parsed.importanceGuess),
    dueHint: cleanText(parsed.dueHint),
    datetimeHint: cleanText(parsed.datetimeHint),
    dueAtIso: normalizeDateTime(parsed.dueAtIso),
    scheduledForIso: normalizeDateTime(parsed.scheduledForIso),
    confidence: clampConfidence(parsed.confidence),
    reasoningSummary: localizeReasoningSummary(cleanText(parsed.reasoningSummary), {
      intent: parsed.detectedIntent,
      confidence: clampConfidence(parsed.confidence),
      dueHint: cleanText(parsed.dueHint),
      datetimeHint: cleanText(parsed.datetimeHint)
    })
  };
}

function parseAiPayload(raw: string): VoiceParsePayload | null {
  try {
    const parsed = JSON.parse(raw) as {
      mode?: "single_item" | "multi_item";
      candidates?: unknown[];
      candidateCountEstimated?: number | null;
    };
    if (!parsed || !Array.isArray(parsed.candidates)) {
      const singleFallback = normalizeCandidate(parsed as unknown);
      if (!singleFallback) return null;
      return {
        mode: "single_item",
        candidates: [
          {
            ...singleFallback,
            candidateId: "c1",
            status: "pending",
            resolvedAt: null,
            resolutionAction: null
          }
        ],
        candidateCountEstimated: 1
      };
    }

    const normalized = parsed.candidates
      .slice(0, 5)
      .map(normalizeCandidate)
      .filter((item): item is VoiceParseSuggestion => Boolean(item));

    if (normalized.length === 0) return null;
    const deduped: VoiceParseSuggestion[] = [];
    const seen = new Set<string>();
    for (const candidate of normalized) {
      const key = `${candidate.detectedIntent}::${normalizeComparableText(candidate.title)}::${normalizeComparableText(candidate.details)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(candidate);
    }
    if (deduped.length === 0) return null;

    const mode = parsed.mode === "multi_item" || deduped.length > 1 ? "multi_item" : "single_item";
    const candidateCountEstimated =
      typeof parsed.candidateCountEstimated === "number" && parsed.candidateCountEstimated > 0
        ? Math.round(parsed.candidateCountEstimated)
        : null;

    return {
      mode,
      candidates: deduped.map((candidate, index) => ({
        ...candidate,
        candidateId: `c${index + 1}`,
        status: "pending",
        resolvedAt: null,
        resolutionAction: null
      })),
      candidateCountEstimated
    };
  } catch {
    // Backward compatibility: older response shape with a single object.
    try {
      const parsedSingle = JSON.parse(raw);
      const single = normalizeCandidate(parsedSingle);
      if (!single) return null;
      return {
        mode: "single_item",
        candidates: [
          {
            ...single,
            candidateId: "c1",
            status: "pending",
            resolvedAt: null,
            resolutionAction: null
          }
        ],
        candidateCountEstimated: 1
      };
    } catch {
      return null;
    }
  }
}

async function parseTranscriptWithAi(
  transcript: string,
  context: ParseContext,
  modeHint: "auto" | "force_multi" = "auto"
): Promise<ParseResult> {
  const openAiApiKey = Deno.env.get("OPENAI_API_KEY");
  if (!openAiApiKey) {
    return {
      status: "skipped",
      provider: "none",
      payload: null,
      error: "openai_not_configured"
    };
  }

  const model = Deno.env.get("OPENAI_MODEL") ?? "gpt-4.1-mini";
  let response: Response;
  try {
    response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${openAiApiKey}`
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        messages: [
          {
            role: "system",
            content:
              "You classify voice notes for a personal execution assistant. Return strict JSON only. Suggestions only, no autonomous actions. Handle Ukrainian, English, and transliterated Ukrainian. Extract up to 5 clearly distinct candidates; prefer fewer high-quality candidates when uncertain. Use detectedIntent=worklog_candidate when the message is primarily a factual update about what already happened, an interruption, a context switch, reactive communication, or a few quick completed follow-ups rather than a future task. Do not turn such updates into tasks by default. Do not split one idea into many tiny items. Resolve date words and weekdays strictly in the provided user timezone. If timing is explicit, fill dueAtIso/scheduledForIso as full ISO-8601 with timezone (Z or +/-HH:MM); otherwise null. Never default an uncertain date/time to 'now'. reasoningSummary must be in Ukrainian, short, and user-friendly."
          },
          {
            role: "user",
            content:
              modeHint === "force_multi"
                ? `Транскрипт голосового повідомлення:\n${transcript}\n\nКонтекст часу користувача:\n- timezone: ${context.timezone}\n- now_utc: ${context.nowIsoUtc}\n\nРежим: multi-item. Спробуй знайти окремі чіткі дії/нотатки. Поверни від 2 до 5 кандидатів, якщо вони справді окремі; інакше 1 кандидат.`
                : `Транскрипт голосового повідомлення:\n${transcript}\n\nКонтекст часу користувача:\n- timezone: ${context.timezone}\n- now_utc: ${context.nowIsoUtc}\n\nПоверни структуровану пропозицію для triage.`
          }
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "voice_parse",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                mode: {
                  type: "string",
                  enum: ["single_item", "multi_item"]
                },
                candidateCountEstimated: { type: ["integer", "null"], minimum: 1 },
                candidates: {
                  type: "array",
                  maxItems: 5,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      detectedIntent: {
                        type: "string",
                        enum: ["task", "note", "worklog_candidate", "meeting_candidate", "reminder_candidate"]
                      },
                      title: { type: "string" },
                      details: { type: "string" },
                      projectGuess: { type: ["string", "null"] },
                      taskTypeGuess: {
                        type: ["string", "null"],
                        enum: [
                          "deep_work",
                          "quick_communication",
                          "admin_operational",
                          "recurring_essential",
                          "personal_essential",
                          "someday",
                          null
                        ]
                      },
                      importanceGuess: { type: ["integer", "null"], minimum: 1, maximum: 5 },
                      dueHint: { type: ["string", "null"] },
                      datetimeHint: { type: ["string", "null"] },
                      dueAtIso: { type: ["string", "null"] },
                      scheduledForIso: { type: ["string", "null"] },
                      confidence: { type: "number", minimum: 0, maximum: 1 },
                      reasoningSummary: { type: "string" }
                    },
                    required: [
                      "detectedIntent",
                      "title",
                      "details",
                      "projectGuess",
                      "taskTypeGuess",
                      "importanceGuess",
                      "dueHint",
                      "datetimeHint",
                      "dueAtIso",
                      "scheduledForIso",
                      "confidence",
                      "reasoningSummary"
                    ]
                  }
                }
              },
              required: ["mode", "candidateCountEstimated", "candidates"]
            }
          }
        }
      })
    });
  } catch (error) {
    console.error("[ingest-voice-telegram] parse_exception", {
      model,
      error: error instanceof Error ? error.message : "unknown_error"
    });
    return {
      status: "failed",
      provider: "openai",
      payload: null,
      error: "parse_exception"
    };
  }

  if (!response.ok) {
    const errorText = shortText(await response.text());
    console.error("[ingest-voice-telegram] parse_request_failed", {
      status: response.status,
      model,
      body: errorText
    });
    return {
      status: "failed",
      provider: "openai",
      payload: null,
      error: `parse_request_failed:${response.status}:${errorText || "no_body"}`
    };
  }

  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = body.choices?.[0]?.message?.content;
  if (!content) {
    return {
      status: "failed",
      provider: "openai",
      payload: null,
      error: "parse_empty_response"
    };
  }

  const payload = parseAiPayload(content);
  if (!payload) {
    console.error("[ingest-voice-telegram] parse_invalid_structure", {
      content: shortText(content)
    });
    return {
      status: "failed",
      provider: "openai",
      payload: null,
      error: "parse_invalid_structure"
    };
  }

  return {
    status: "ok",
    provider: "openai",
    payload,
    error: null
  };
}

async function improveMultiItemSplitIfNeeded(
  transcript: string,
  context: ParseContext,
  baseResult: ParseResult
): Promise<ParseResult> {
  if (baseResult.status !== "ok") return baseResult;
  if (baseResult.payload.mode === "multi_item" || baseResult.payload.candidates.length > 1) return baseResult;
  if (!hasStrongSplitSignals(transcript)) return baseResult;

  const retry = await parseTranscriptWithAi(transcript, context, "force_multi");
  if (retry.status !== "ok") return baseResult;
  if (retry.payload.candidates.length <= baseResult.payload.candidates.length) return baseResult;
  return retry;
}

async function matchProjectGuess(
  supabase: ReturnType<typeof createAdminClient>,
  userId: string,
  projectGuess: string | null
): Promise<ProjectMatch> {
  const normalizedGuess = projectGuess ? normalizeComparableText(projectGuess) : "";
  if (!normalizedGuess) {
    return {
      status: "none",
      guessedName: null,
      matchedProjectId: null,
      matchedProjectName: null,
      score: null,
      strategy: null
    };
  }

  const { data, error } = await supabase
    .from("projects")
    .select("id, name, status, aliases")
    .eq("user_id", userId)
    .neq("status", "archived");

  if (error || !data?.length) {
    return {
      status: "suggested_only",
      guessedName: projectGuess,
      matchedProjectId: null,
      matchedProjectName: null,
      score: null,
      strategy: null
    };
  }

  for (const project of data) {
    const aliases = Array.isArray(project.aliases)
      ? project.aliases.filter((value): value is string => typeof value === "string")
      : [];
    const candidateNames = [project.name, ...aliases];
    const matchedName = candidateNames.find((value) => normalizeComparableText(value) === normalizedGuess);
    if (!matchedName) continue;

    return {
      status: "matched",
      guessedName: projectGuess,
      matchedProjectId: project.id,
      matchedProjectName: project.name,
      score: 1,
      strategy: "exact_normalized"
    };
  }

  return {
    status: "suggested_only",
    guessedName: projectGuess,
    matchedProjectId: null,
    matchedProjectName: null,
    score: null,
    strategy: null
  };
}


Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
  }

  const requiredToken = Deno.env.get("BOT_INGEST_TOKEN");
  const providedToken = req.headers.get("x-bot-ingest-token");
  if (!requiredToken || !providedToken || providedToken !== requiredToken) {
    return unauthorized();
  }

  const body = await safeJson<IngestVoiceBody>(req);
  if (!body?.telegramUserId || !body.voiceFileId) {
    return jsonResponse({ ok: false, error: "missing_fields" }, 400);
  }

  const supabase = createAdminClient();
  const { data: userRow, error: userError } = await supabase
    .from("users")
    .upsert({ telegram_user_id: body.telegramUserId }, { onConflict: "telegram_user_id" })
    .select("id")
    .single();

  if (userError || !userRow) {
    return jsonResponse({ ok: false, error: "user_upsert_failed" }, 500);
  }

  await supabase.from("profiles").upsert({ user_id: userRow.id }, { onConflict: "user_id" });
  const { data: profileRow } = await supabase
    .from("profiles")
    .select("timezone")
    .eq("user_id", userRow.id)
    .maybeSingle();
  const userTimezone = normalizeTimezone((profileRow?.timezone as string | null | undefined) ?? null);

  const fileFetch = await fetchTelegramVoiceBytes(body.voiceFileId);
  let transcript: TranscriptResult;
  let parse: ParseResult;
  let filePath: string | null = null;

  if (!fileFetch.ok) {
    console.warn("[ingest-voice-telegram] telegram_file_fetch_failed", {
      voiceFileId: body.voiceFileId,
      error: fileFetch.error
    });
    transcript = {
      status: "failed",
      text: null,
      language: null,
      provider: "none",
      error: fileFetch.error
    };
    parse = {
      status: "skipped",
      provider: "none",
      payload: null,
      error: "transcript_unavailable"
    };
  } else {
    filePath = fileFetch.filePath;
    transcript = await transcribeVoice(fileFetch.bytes, fileFetch.mimeType);
    if (transcript.status === "ok" && transcript.text) {
      const parseContext = {
        timezone: userTimezone,
        nowIsoUtc: new Date().toISOString()
      };
      const baseParse = await parseTranscriptWithAi(transcript.text, parseContext);
      parse = await improveMultiItemSplitIfNeeded(transcript.text, parseContext, baseParse);
    } else {
      parse = {
        status: "skipped",
        provider: "none",
        payload: null,
        error: "transcript_unavailable"
      };
    }
  }

  const primaryCandidate = parse.payload?.candidates[0] ?? null;
  const candidateCountShown = parse.payload?.candidates.length ?? 0;

  const projectMatch =
    primaryCandidate?.projectGuess
      ? await matchProjectGuess(supabase, userRow.id, primaryCandidate.projectGuess)
      : {
          status: "none",
          guessedName: null,
          matchedProjectId: null,
          matchedProjectName: null,
          score: null,
          strategy: null
        };

  const voiceMeta = {
    version: "v1.6",
    transcript: {
      status: transcript.status,
      provider: transcript.provider,
      language: transcript.language,
      error: transcript.error
    },
    parse: {
      status: parse.status,
      provider: parse.provider,
      error: parse.error
    },
    mode: parse.payload?.mode ?? "single_item",
    projectMatch,
    suggestedKind: primaryCandidate?.detectedIntent ?? null,
    parseConfidence: primaryCandidate?.confidence ?? null,
    parseSuggestion: primaryCandidate,
    candidates: parse.payload?.candidates ?? null,
    candidateCountShown,
    candidateCountEstimated: parse.payload?.candidateCountEstimated ?? null,
    sourceMeta: {
      telegramUserId: body.telegramUserId,
      telegramChatId: body.telegramChatId ?? null,
      telegramMessageId: body.telegramMessageId ?? null,
      voiceFileId: body.voiceFileId,
      voiceDurationSec: body.voiceDurationSec ?? null,
      voiceMimeType: body.voiceMimeType ?? null,
      voiceFileSize: body.voiceFileSize ?? null,
      telegramFilePath: filePath,
      userTimezone
    }
  };

  const { data: inboxItem, error: insertError } = await supabase
    .from("inbox_items")
    .insert({
      user_id: userRow.id,
      status: "new",
      source_type: "voice",
      source_channel: "telegram_bot",
      raw_text: null,
      transcript_text: transcript.text,
      voice_file_id: body.voiceFileId,
      meta: {
        capture_kind: "voice",
        voice_ai: voiceMeta
      }
    })
    .select("id")
    .single();

  if (insertError || !inboxItem) {
    console.error("[ingest-voice-telegram] inbox_insert_failed", {
      message: insertError?.message ?? null,
      details: insertError?.details ?? null,
      hint: insertError?.hint ?? null
    });
    return jsonResponse({ ok: false, error: "capture_failed" }, 500);
  }

  return jsonResponse({
    ok: true,
    inboxItemId: inboxItem.id,
    transcriptStatus: transcript.status,
    parseStatus: parse.status,
    detectedIntent: primaryCandidate?.detectedIntent ?? null,
    confidence: primaryCandidate?.confidence ?? null,
    candidateCountShown
  });
});



