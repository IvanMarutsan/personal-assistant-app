import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";

const DEBUG_STORAGE_KEY = "personal_assistant_debug_mode";
const SESSION_KEY = "personal_assistant_app_session_token";

type DiagnosticsAction = {
  name: string;
  at: string;
  context?: Record<string, string | number | boolean | null | undefined>;
};

type DiagnosticsRequestFailure = {
  path: string;
  status: number;
  code: string | null;
  message: string;
  details: string | null;
  at: string;
};

type DiagnosticsContextValue = {
  debugEnabled: boolean;
  buildMarker: string;
  environmentLabel: string;
  currentRoute: string;
  timezone: string;
  sessionState: "активна" | "відсутня";
  lastRefreshAt: string | null;
  lastAction: DiagnosticsAction | null;
  lastFailure: DiagnosticsRequestFailure | null;
  screenDataSource: string | null;
  trackAction: (name: string, context?: Record<string, string | number | boolean | null | undefined>) => void;
  trackFailure: (input: {
    path: string;
    status: number;
    code?: string | null;
    message: string;
    details?: string | null;
  }) => void;
  markRefresh: () => void;
  setScreenDataSource: (value: string | null) => void;
  copyDiagnostics: () => Promise<boolean>;
  copyIssueTemplate: () => Promise<boolean>;
};

const DiagnosticsContext = createContext<DiagnosticsContextValue | null>(null);

function detectEnvironmentLabel(hostname: string): string {
  if (hostname === "localhost" || hostname === "127.0.0.1") return "локально";
  if (hostname.endsWith(".ngrok-free.app") || hostname.endsWith(".ngrok-free.dev")) return "тунель ngrok";
  if (hostname.endsWith(".trycloudflare.com")) return "тунель Cloudflare";
  if (hostname.includes("vercel.app")) return "розгортання Vercel";
  return "розгорнуте середовище";
}

function toIsoNow(): string {
  return new Date().toISOString();
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const textArea = document.createElement("textarea");
      textArea.value = text;
      textArea.style.position = "fixed";
      textArea.style.left = "-9999px";
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(textArea);
      return ok;
    } catch {
      return false;
    }
  }
}

export function DiagnosticsProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const [debugEnabled, setDebugEnabled] = useState<boolean>(false);
  const [lastAction, setLastAction] = useState<DiagnosticsAction | null>(null);
  const [lastFailure, setLastFailure] = useState<DiagnosticsRequestFailure | null>(null);
  const [lastRefreshAt, setLastRefreshAt] = useState<string | null>(null);
  const [screenDataSource, setScreenDataSourceState] = useState<string | null>(null);
  const [sessionState, setSessionState] = useState<"активна" | "відсутня">("відсутня");

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const debugParam = params.get("debug");
    if (debugParam === "1") {
      localStorage.setItem(DEBUG_STORAGE_KEY, "1");
      setDebugEnabled(true);
      return;
    }
    if (debugParam === "0") {
      localStorage.removeItem(DEBUG_STORAGE_KEY);
      setDebugEnabled(false);
      return;
    }
    setDebugEnabled(localStorage.getItem(DEBUG_STORAGE_KEY) === "1");
  }, [location.search]);

  useEffect(() => {
    const token = localStorage.getItem(SESSION_KEY);
    setSessionState(token ? "активна" : "відсутня");
  }, [location.pathname, location.search]);

  const environmentLabel = useMemo(() => detectEnvironmentLabel(window.location.hostname), []);

  function trackAction(name: string, context?: Record<string, string | number | boolean | null | undefined>) {
    setLastAction({ name, at: toIsoNow(), context });
  }

  function trackFailure(input: {
    path: string;
    status: number;
    code?: string | null;
    message: string;
    details?: string | null;
  }) {
    setLastFailure({
      path: input.path,
      status: input.status,
      code: input.code ?? null,
      message: input.message,
      details: input.details ?? null,
      at: toIsoNow()
    });
  }

  function markRefresh() {
    setLastRefreshAt(toIsoNow());
  }

  function setScreenDataSource(value: string | null) {
    setScreenDataSourceState(value);
  }

  function buildDiagnosticsText(issueTemplate = false): string {
    const lines: string[] = [];
    lines.push(issueTemplate ? "Звіт про проблему Mini App" : "Діагностика Mini App");
    lines.push(`timestamp=${toIsoNow()}`);
    lines.push(`route=${location.pathname}`);
    lines.push(`environment=${environmentLabel}`);
    lines.push(`timezone=${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
    lines.push(`session=${sessionState}`);
    lines.push(`last_refresh_at=${lastRefreshAt ?? "-"}`);
    lines.push(`screen_data_source=${screenDataSource ?? "-"}`);
    lines.push(`last_action=${lastAction ? `${lastAction.name} @ ${lastAction.at}` : "-"}`);
    if (lastAction?.context) {
      lines.push(`last_action_context=${JSON.stringify(lastAction.context)}`);
    }
    if (lastFailure) {
      lines.push(`last_failure_path=${lastFailure.path}`);
      lines.push(`last_failure_status=${lastFailure.status}`);
      lines.push(`last_failure_code=${lastFailure.code ?? "-"}`);
      lines.push(`last_failure_message=${lastFailure.message}`);
      lines.push(`last_failure_details=${lastFailure.details ?? "-"}`);
      lines.push(`last_failure_at=${lastFailure.at}`);
    } else {
      lines.push("last_failure=none");
    }
    lines.push(`build_marker=${import.meta.env.VITE_APP_BUILD ?? "dev-local"}`);
    if (issueTemplate) {
      lines.push("");
      lines.push("Що очікував(ла): ...");
      lines.push("Що фактично сталося: ...");
      lines.push("Кроки відтворення: ...");
    }
    return lines.join("\n");
  }

  async function copyDiagnostics(): Promise<boolean> {
    return copyText(buildDiagnosticsText(false));
  }

  async function copyIssueTemplate(): Promise<boolean> {
    return copyText(buildDiagnosticsText(true));
  }

  const value: DiagnosticsContextValue = {
    debugEnabled,
    buildMarker: import.meta.env.VITE_APP_BUILD ?? "dev-local",
    environmentLabel,
    currentRoute: location.pathname,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    sessionState,
    lastRefreshAt,
    lastAction,
    lastFailure,
    screenDataSource,
    trackAction,
    trackFailure,
    markRefresh,
    setScreenDataSource,
    copyDiagnostics,
    copyIssueTemplate
  };

  return <DiagnosticsContext.Provider value={value}>{children}</DiagnosticsContext.Provider>;
}

export function useDiagnostics(): DiagnosticsContextValue {
  const context = useContext(DiagnosticsContext);
  if (!context) {
    throw new Error("useDiagnostics must be used within DiagnosticsProvider");
  }
  return context;
}
