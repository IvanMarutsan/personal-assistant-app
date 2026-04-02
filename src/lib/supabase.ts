import { createClient } from "@supabase/supabase-js";
import { appEnv } from "./env";

export const supabase = createClient(appEnv.supabaseUrl, appEnv.supabaseAnonKey);
