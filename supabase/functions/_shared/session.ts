import { createHash } from "node:crypto";
import { createAdminClient, requiredEnv } from "./db.ts";

const SESSION_TTL_SECONDS = Number(Deno.env.get("APP_SESSION_TTL_SECONDS") ?? "86400");
const SESSION_PEPPER = Deno.env.get("APP_SESSION_PEPPER") ?? requiredEnv("SUPABASE_SERVICE_ROLE_KEY");

export type SessionUser = {
  userId: string;
};

function hashToken(token: string): string {
  return createHash("sha256").update(`${SESSION_PEPPER}:${token}`).digest("hex");
}

export function extractSessionToken(req: Request): string | null {
  const appSession = req.headers.get("x-app-session");
  if (appSession) return appSession;

  const authorization = req.headers.get("authorization");
  if (!authorization) return null;

  const [scheme, token] = authorization.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  return token;
}

export function createSessionToken(): { token: string; tokenHash: string; expiresAt: string } {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
  return { token, tokenHash: hashToken(token), expiresAt };
}

export async function resolveSessionUser(req: Request): Promise<SessionUser | null> {
  const token = extractSessionToken(req);
  if (!token) return null;

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("app_sessions")
    .select("user_id, expires_at")
    .eq("token_hash", hashToken(token))
    .maybeSingle();

  if (error || !data) return null;
  if (new Date(data.expires_at).getTime() <= Date.now()) return null;

  return { userId: data.user_id as string };
}
