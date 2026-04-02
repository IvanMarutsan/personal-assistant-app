function required(name: string): string {
  const value = import.meta.env[name as keyof ImportMetaEnv] as string | undefined;
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export const appEnv = {
  supabaseUrl: required("VITE_SUPABASE_URL"),
  supabaseAnonKey: required("VITE_SUPABASE_ANON_KEY"),
  edgeBaseUrl: required("VITE_EDGE_BASE_URL")
};
