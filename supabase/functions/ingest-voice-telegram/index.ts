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

type VoiceIntent = "task" | "note" | "meeting_candidate" | "reminder_candidate";
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
      suggestion: VoiceParseSuggestion;
      error: null;
    }
  | {
      status: "failed" | "skipped";
      provider: "openai" | "none";
      suggestion: null;
      error: string;
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
      return {
        status: "failed",
        text: null,
        language: null,
        provider: "openai",
        error: "transcription_request_failed"
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
  } catch {
    return {
      status: "failed",
      text: null,
      language: null,
      provider: "openai",
      error: "transcription_exception"
    };
  }
}

function parseAiSuggestion(raw: string): VoiceParseSuggestion | null {
  try {
    const parsed = JSON.parse(raw) as {
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
      !parsed ||
      typeof parsed.detectedIntent !== "string" ||
      typeof parsed.title !== "string" ||
      typeof parsed.details !== "string" ||
      typeof parsed.confidence !== "number" ||
      typeof parsed.reasoningSummary !== "string"
    ) {
      return null;
    }

    const allowedIntents: VoiceIntent[] = ["task", "note", "meeting_candidate", "reminder_candidate"];
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
      reasoningSummary: cleanText(parsed.reasoningSummary) ?? "Коротке пояснення недоступне."
    };
  } catch {
    return null;
  }
}

async function parseTranscriptWithAi(transcript: string): Promise<ParseResult> {
  const openAiApiKey = Deno.env.get("OPENAI_API_KEY");
  if (!openAiApiKey) {
    return {
      status: "skipped",
      provider: "none",
      suggestion: null,
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
              "You classify voice notes for a personal execution assistant. Return strict JSON only. Suggestions only, no autonomous actions. Handle Ukrainian, English, and transliterated Ukrainian. If timing is explicit, fill dueAtIso/scheduledForIso as ISO-8601; otherwise null."
          },
          {
            role: "user",
            content: `Транскрипт голосового повідомлення:\n${transcript}\n\nПоверни структуровану пропозицію для triage.`
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
                detectedIntent: {
                  type: "string",
                  enum: ["task", "note", "meeting_candidate", "reminder_candidate"]
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
        }
      })
    });
  } catch {
    return {
      status: "failed",
      provider: "openai",
      suggestion: null,
      error: "parse_exception"
    };
  }

  if (!response.ok) {
    return {
      status: "failed",
      provider: "openai",
      suggestion: null,
      error: "parse_request_failed"
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
      suggestion: null,
      error: "parse_empty_response"
    };
  }

  const suggestion = parseAiSuggestion(content);
  if (!suggestion) {
    return {
      status: "failed",
      provider: "openai",
      suggestion: null,
      error: "parse_invalid_structure"
    };
  }

  return {
    status: "ok",
    provider: "openai",
    suggestion,
    error: null
  };
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
    .select("id, name, status")
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

  const exact = data.find((project) => normalizeComparableText(project.name) === normalizedGuess);
  if (exact) {
    return {
      status: "matched",
      guessedName: projectGuess,
      matchedProjectId: exact.id,
      matchedProjectName: exact.name,
      score: 1,
      strategy: "exact_normalized"
    };
  }

  let best: { id: string; name: string; score: number } | null = null;
  for (const project of data) {
    const score = similarityScore(normalizedGuess, normalizeComparableText(project.name));
    if (!best || score > best.score) {
      best = { id: project.id, name: project.name, score };
    }
  }

  if (best && best.score >= 0.7) {
    return {
      status: "matched",
      guessedName: projectGuess,
      matchedProjectId: best.id,
      matchedProjectName: best.name,
      score: Number(best.score.toFixed(3)),
      strategy: "similarity"
    };
  }

  return {
    status: "suggested_only",
    guessedName: projectGuess,
    matchedProjectId: null,
    matchedProjectName: null,
    score: best ? Number(best.score.toFixed(3)) : null,
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

  const fileFetch = await fetchTelegramVoiceBytes(body.voiceFileId);
  let transcript: TranscriptResult;
  let parse: ParseResult;
  let filePath: string | null = null;

  if (!fileFetch.ok) {
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
      suggestion: null,
      error: "transcript_unavailable"
    };
  } else {
    filePath = fileFetch.filePath;
    transcript = await transcribeVoice(fileFetch.bytes, fileFetch.mimeType);
    if (transcript.status === "ok" && transcript.text) {
      parse = await parseTranscriptWithAi(transcript.text);
    } else {
      parse = {
        status: "skipped",
        provider: "none",
        suggestion: null,
        error: "transcript_unavailable"
      };
    }
  }

  const projectMatch =
    parse.suggestion?.projectGuess
      ? await matchProjectGuess(supabase, userRow.id, parse.suggestion.projectGuess)
      : {
          status: "none",
          guessedName: null,
          matchedProjectId: null,
          matchedProjectName: null,
          score: null,
          strategy: null
        };

  const voiceMeta = {
    version: "v1.5",
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
    projectMatch,
    suggestedKind: parse.suggestion?.detectedIntent ?? null,
    parseConfidence: parse.suggestion?.confidence ?? null,
    parseSuggestion: parse.suggestion,
    sourceMeta: {
      telegramUserId: body.telegramUserId,
      telegramChatId: body.telegramChatId ?? null,
      telegramMessageId: body.telegramMessageId ?? null,
      voiceFileId: body.voiceFileId,
      voiceDurationSec: body.voiceDurationSec ?? null,
      voiceMimeType: body.voiceMimeType ?? null,
      voiceFileSize: body.voiceFileSize ?? null,
      telegramFilePath: filePath
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
    return jsonResponse({ ok: false, error: "capture_failed" }, 500);
  }

  return jsonResponse({
    ok: true,
    inboxItemId: inboxItem.id,
    transcriptStatus: transcript.status,
    parseStatus: parse.status,
    detectedIntent: parse.suggestion?.detectedIntent ?? null,
    confidence: parse.suggestion?.confidence ?? null
  });
});
