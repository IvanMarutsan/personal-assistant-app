import { handleOptions, jsonResponse } from "../_shared/http.ts";
import { resolveSessionUser } from "../_shared/session.ts";

function cleanText(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function shortText(value: string, limit = 280): string {
  if (!value) return "";
  return value.length <= limit ? value : `${value.slice(0, limit)}...`;
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

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return jsonResponse({ ok: false, error: "invalid_form_data", message: "Не вдалося прочитати аудіофайл." }, 400);
  }

  const fileValue = formData.get("file");
  if (!(fileValue instanceof File) || fileValue.size <= 0) {
    return jsonResponse({ ok: false, error: "missing_audio_file", message: "Додай аудіофайл для розпізнавання." }, 400);
  }

  const openAiApiKey = Deno.env.get("OPENAI_API_KEY");
  if (!openAiApiKey) {
    return jsonResponse({ ok: false, error: "transcription_unavailable", message: "Розпізнавання голосу зараз недоступне." }, 503);
  }

  const model = Deno.env.get("OPENAI_TRANSCRIBE_MODEL") ?? "gpt-4o-mini-transcribe";
  const payload = new FormData();
  payload.append("model", model);
  payload.append("language", "uk");
  payload.append("response_format", "json");
  payload.append("file", fileValue, fileValue.name || "planning-voice.webm");

  try {
    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${openAiApiKey}`
      },
      body: payload
    });

    if (!response.ok) {
      const errorText = shortText(await response.text());
      console.error("[transcribe-planning-voice] transcription_request_failed", {
        userId: sessionUser.userId,
        status: response.status,
        model,
        body: errorText
      });
      return jsonResponse(
        { ok: false, error: "transcription_failed", message: "Не вдалося розпізнати голос. Спробуй ще раз." },
        502
      );
    }

    const body = (await response.json()) as { text?: string; language?: string };
    const transcript = cleanText(body.text);
    if (!transcript) {
      return jsonResponse(
        { ok: false, error: "empty_transcription", message: "Не вдалося отримати текст із запису." },
        422
      );
    }

    return jsonResponse({
      ok: true,
      transcript,
      language: body.language ?? null,
      provider: "openai"
    });
  } catch (error) {
    console.error("[transcribe-planning-voice] transcription_exception", {
      userId: sessionUser.userId,
      model,
      error: error instanceof Error ? error.message : "unknown_error"
    });
    return jsonResponse(
      { ok: false, error: "transcription_exception", message: "Не вдалося розпізнати голос. Спробуй ще раз." },
      502
    );
  }
});
