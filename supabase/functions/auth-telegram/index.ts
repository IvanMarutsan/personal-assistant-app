import { createAdminClient, requiredEnv } from "../_shared/db.ts";
import { handleOptions, jsonResponse, safeJson } from "../_shared/http.ts";
import { createSessionToken } from "../_shared/session.ts";
import { verifyAndParseTelegramInitData } from "../_shared/telegram.ts";

type AuthTelegramBody = {
  initDataRaw?: string;
};

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
  }

  const body = await safeJson<AuthTelegramBody>(req);
  if (!body?.initDataRaw) {
    return jsonResponse({ ok: false, error: "missing_init_data" }, 400);
  }

  try {
    const { telegramUserId, displayName } = verifyAndParseTelegramInitData(
      body.initDataRaw,
      requiredEnv("TELEGRAM_BOT_TOKEN")
    );

    const supabase = createAdminClient();

    const { data: userRow, error: userError } = await supabase
      .from("users")
      .upsert({ telegram_user_id: telegramUserId }, { onConflict: "telegram_user_id" })
      .select("id")
      .single();

    if (userError || !userRow) {
      return jsonResponse({ ok: false, error: "user_upsert_failed" }, 500);
    }

    await supabase.from("profiles").upsert(
      {
        user_id: userRow.id,
        display_name: displayName
      },
      { onConflict: "user_id" }
    );

    const { token, tokenHash, expiresAt } = createSessionToken();

    const { error: sessionError } = await supabase.from("app_sessions").insert({
      user_id: userRow.id,
      token_hash: tokenHash,
      expires_at: expiresAt
    });

    if (sessionError) {
      return jsonResponse({ ok: false, error: "session_create_failed" }, 500);
    }

    return jsonResponse({
      ok: true,
      session: {
        token,
        expiresAt,
        userId: userRow.id
      },
      user: {
        telegramUserId,
        displayName
      }
    });
  } catch (error) {
    return jsonResponse(
      {
        ok: false,
        error: "telegram_auth_failed",
        message: error instanceof Error ? error.message : "Unknown error"
      },
      401
    );
  }
});
