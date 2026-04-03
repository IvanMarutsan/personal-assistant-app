import { createHash } from "node:crypto";
import { createAdminClient, requiredEnv } from "./db.ts";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEFAULT_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly"
].join(" ");
const STATE_TTL_SECONDS = Number(Deno.env.get("GOOGLE_OAUTH_STATE_TTL_SECONDS") ?? "600");
const TOKEN_REFRESH_BUFFER_SECONDS = Number(Deno.env.get("GOOGLE_TOKEN_REFRESH_BUFFER_SECONDS") ?? "90");
const STATE_PEPPER = Deno.env.get("GOOGLE_OAUTH_STATE_PEPPER") ?? requiredEnv("SUPABASE_SERVICE_ROLE_KEY");

export type GoogleCalendarConnection = {
  user_id: string;
  provider: string;
  google_email: string | null;
  access_token: string;
  refresh_token: string | null;
  token_type: string | null;
  scope: string | null;
  expires_at: string | null;
  calendar_id: string;
};

type TokenResponse = {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  id_token?: string;
};

function randomHex(bytes = 24): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function stateHash(state: string): string {
  return createHash("sha256").update(`${STATE_PEPPER}:${state}`).digest("hex");
}

function computeExpiresAt(expiresInSeconds?: number): string | null {
  if (!expiresInSeconds || !Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) return null;
  return new Date(Date.now() + expiresInSeconds * 1000).toISOString();
}

function isExpiringSoon(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  const ms = new Date(expiresAt).getTime();
  if (Number.isNaN(ms)) return true;
  return ms <= Date.now() + TOKEN_REFRESH_BUFFER_SECONDS * 1000;
}

function googleClientId(): string {
  return requiredEnv("GOOGLE_CLIENT_ID");
}

function googleClientSecret(): string {
  return requiredEnv("GOOGLE_CLIENT_SECRET");
}

export function googleRedirectUri(): string {
  return requiredEnv("GOOGLE_REDIRECT_URI");
}

export function googleScopes(): string {
  return Deno.env.get("GOOGLE_CALENDAR_SCOPES")?.trim() || DEFAULT_SCOPES;
}

export function miniAppBaseUrl(): string {
  return requiredEnv("MINI_APP_BASE_URL");
}

export async function createOAuthState(input: { userId: string; returnPath: string }): Promise<string> {
  const supabase = createAdminClient();
  const rawState = randomHex(32);
  const expiresAt = new Date(Date.now() + STATE_TTL_SECONDS * 1000).toISOString();

  const { error } = await supabase.from("calendar_oauth_states").insert({
    user_id: input.userId,
    state_hash: stateHash(rawState),
    return_path: input.returnPath,
    expires_at: expiresAt
  });

  if (error) throw new Error("oauth_state_create_failed");
  return rawState;
}

export async function consumeOAuthState(rawState: string): Promise<{ userId: string; returnPath: string } | null> {
  const supabase = createAdminClient();
  const hash = stateHash(rawState);

  const { data, error } = await supabase
    .from("calendar_oauth_states")
    .select("id, user_id, return_path, expires_at")
    .eq("state_hash", hash)
    .maybeSingle();

  if (error || !data) return null;
  if (new Date(data.expires_at).getTime() <= Date.now()) {
    await supabase.from("calendar_oauth_states").delete().eq("id", data.id);
    return null;
  }

  await supabase.from("calendar_oauth_states").delete().eq("id", data.id);
  return { userId: data.user_id as string, returnPath: (data.return_path as string) || "/calendar" };
}

export function buildGoogleAuthUrl(state: string): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", googleClientId());
  url.searchParams.set("redirect_uri", googleRedirectUri());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("scope", googleScopes());
  url.searchParams.set("state", state);
  return url.toString();
}

async function exchangeToken(params: URLSearchParams): Promise<TokenResponse> {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params.toString()
  });

  const data = (await response.json().catch(() => null)) as TokenResponse | null;
  if (!response.ok || !data?.access_token) {
    throw new Error("google_token_exchange_failed");
  }
  return data;
}

export async function exchangeGoogleCodeForToken(code: string): Promise<TokenResponse> {
  const params = new URLSearchParams();
  params.set("code", code);
  params.set("client_id", googleClientId());
  params.set("client_secret", googleClientSecret());
  params.set("redirect_uri", googleRedirectUri());
  params.set("grant_type", "authorization_code");
  return exchangeToken(params);
}

async function refreshGoogleToken(refreshToken: string): Promise<TokenResponse> {
  const params = new URLSearchParams();
  params.set("refresh_token", refreshToken);
  params.set("client_id", googleClientId());
  params.set("client_secret", googleClientSecret());
  params.set("grant_type", "refresh_token");
  return exchangeToken(params);
}

export async function fetchGoogleEmail(accessToken: string): Promise<string | null> {
  try {
    const response = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { authorization: `Bearer ${accessToken}` }
    });
    if (!response.ok) return null;
    const data = (await response.json().catch(() => null)) as { email?: string } | null;
    return data?.email ?? null;
  } catch {
    return null;
  }
}

export async function upsertGoogleConnection(input: {
  userId: string;
  token: TokenResponse;
  googleEmail?: string | null;
}): Promise<void> {
  const supabase = createAdminClient();

  const { data: existing } = await supabase
    .from("calendar_connections")
    .select("refresh_token")
    .eq("user_id", input.userId)
    .eq("provider", "google")
    .maybeSingle();

  const refreshToken = input.token.refresh_token ?? (existing?.refresh_token as string | null) ?? null;

  const { error } = await supabase.from("calendar_connections").upsert(
    {
      user_id: input.userId,
      provider: "google",
      google_email: input.googleEmail ?? null,
      access_token: input.token.access_token,
      refresh_token: refreshToken,
      token_type: input.token.token_type ?? null,
      scope: input.token.scope ?? null,
      expires_at: computeExpiresAt(input.token.expires_in),
      calendar_id: "primary"
    },
    { onConflict: "user_id,provider" }
  );

  if (error) throw new Error("google_connection_upsert_failed");
}

export async function getGoogleConnection(userId: string): Promise<GoogleCalendarConnection | null> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("calendar_connections")
    .select("user_id, provider, google_email, access_token, refresh_token, token_type, scope, expires_at, calendar_id")
    .eq("user_id", userId)
    .eq("provider", "google")
    .maybeSingle();

  if (error) throw new Error("calendar_connection_fetch_failed");
  return (data as GoogleCalendarConnection | null) ?? null;
}

export async function getGoogleAccessTokenForUser(userId: string): Promise<{
  accessToken: string;
  calendarId: string;
  googleEmail: string | null;
}> {
  const connection = await getGoogleConnection(userId);
  if (!connection) throw new Error("calendar_not_connected");

  if (!isExpiringSoon(connection.expires_at)) {
    return {
      accessToken: connection.access_token,
      calendarId: connection.calendar_id || "primary",
      googleEmail: connection.google_email
    };
  }

  if (!connection.refresh_token) throw new Error("calendar_refresh_token_missing");

  const refreshed = await refreshGoogleToken(connection.refresh_token);
  const supabase = createAdminClient();

  const { error } = await supabase
    .from("calendar_connections")
    .update({
      access_token: refreshed.access_token,
      token_type: refreshed.token_type ?? connection.token_type,
      scope: refreshed.scope ?? connection.scope,
      expires_at: computeExpiresAt(refreshed.expires_in)
    })
    .eq("user_id", userId)
    .eq("provider", "google");

  if (error) throw new Error("calendar_refresh_update_failed");

  return {
    accessToken: refreshed.access_token,
    calendarId: connection.calendar_id || "primary",
    googleEmail: connection.google_email
  };
}

export function buildMiniAppReturnUrl(input: {
  returnPath: string;
  status: "success" | "error";
  reason?: string;
}): string {
  const base = miniAppBaseUrl();
  const normalized = input.returnPath.startsWith("/") ? input.returnPath : `/${input.returnPath}`;
  const url = new URL(normalized, base);
  url.searchParams.set("calendar_connect", input.status);
  if (input.reason) url.searchParams.set("reason", input.reason);
  return url.toString();
}
