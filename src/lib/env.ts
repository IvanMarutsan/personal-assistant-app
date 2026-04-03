function required(name: string): string {
  const value = import.meta.env[name as keyof ImportMetaEnv] as string | undefined;
  if (!value?.trim()) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value.trim();
}

function optional(name: string): string | null {
  const value = import.meta.env[name as keyof ImportMetaEnv] as string | undefined;
  if (!value?.trim()) return null;
  return value.trim();
}

function ensureHttpUrl(name: string, value: string): string {
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error(`${name} must use http or https`);
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
}

function resolveEdgeBaseUrl(supabaseUrl: string): string {
  const explicit = optional("VITE_EDGE_BASE_URL");
  if (explicit) return ensureHttpUrl("VITE_EDGE_BASE_URL", explicit);
  return `${supabaseUrl}/functions/v1`;
}

const supabaseUrl = ensureHttpUrl("VITE_SUPABASE_URL", required("VITE_SUPABASE_URL"));
const supabaseAnonKey = required("VITE_SUPABASE_ANON_KEY");
const edgeBaseUrl = resolveEdgeBaseUrl(supabaseUrl);

if (import.meta.env.DEV) {
  console.info("[env] runtime config", {
    supabaseUrl,
    edgeBaseUrl,
    hasAnonKey: Boolean(supabaseAnonKey)
  });
}

export const appEnv = {
  supabaseUrl,
  supabaseAnonKey,
  edgeBaseUrl
};
