import { useEffect, useMemo, useRef, useState } from "react";
import { InboxTriageModal } from "../../components/InboxTriageModal";
import { VoiceConfirmModal } from "../../components/VoiceConfirmModal";
import { useDiagnostics } from "../../lib/diagnostics";
import {
  ApiError,
  authTelegram,
  createGoogleCalendarEvent,
  getGoogleCalendarStatus,
  getInbox,
  getProjects,
  getTelegramInitDataRaw,
  resolveVoiceCandidate,
  triageInboxItem
} from "../../lib/api";
import type {
  GoogleCalendarStatus,
  InboxItem,
  ProjectItem,
  TaskType,
  VoiceAiCandidate,
  VoiceAiSuggestion,
  VoiceConfirmTargetKind,
  VoiceDetectedIntent,
  VoiceCandidateStatus
} from "../../types/api";

const SESSION_KEY = "personal_assistant_app_session_token";

type AuthState = "idle" | "authenticating" | "ready" | "error";

type VoiceConfirmState = {
  item: InboxItem;
  candidateId: string | null;
  defaultKind: VoiceConfirmTargetKind;
  suggestion: VoiceAiSuggestion;
  projectMatch: {
    status: "matched" | "suggested_only" | "none";
    matchedProjectId: string | null;
    matchedProjectName: string | null;
    score: number | null;
  } | null;
} | null;

type PreparedInboxItem = {
  item: InboxItem;
  suggestion: VoiceAiSuggestion | null;
  candidates: VoiceAiCandidate[];
  parseMode: "single_item" | "multi_item" | null;
  candidateCountEstimated: number | null;
  projectMatch: {
    status: "matched" | "suggested_only" | "none";
    matchedProjectId: string | null;
    matchedProjectName: string | null;
    score: number | null;
  } | null;
  statuses: {
    transcriptStatus: string | null;
    parseStatus: string | null;
    transcriptError: string | null;
    parseError: string | null;
  };
  isVoiceItem: boolean;
};

function previewText(item: InboxItem): string {
  return item.raw_text ?? item.transcript_text ?? "(голосове без транскрипту)";
}

function sourceLabel(item: InboxItem): string {
  const channel = item.source_channel === "telegram_bot" ? "telegram_bot" : "mini_app";
  const source = item.source_type === "voice" ? "voice" : "text";
  const channelLabel = channel === "telegram_bot" ? "Telegram бот" : "Mini App";
  const sourceText = source === "voice" ? "голос" : "текст";
  return `${channelLabel} / ${sourceText}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function toNullableString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toNullableNumber(value: unknown): number | null {
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  return value;
}

function toTaskType(value: unknown): TaskType | null {
  const allowed: TaskType[] = [
    "deep_work",
    "quick_communication",
    "admin_operational",
    "recurring_essential",
    "personal_essential",
    "someday"
  ];
  if (typeof value !== "string") return null;
  return allowed.includes(value as TaskType) ? (value as TaskType) : null;
}

function toDetectedIntent(value: unknown): VoiceDetectedIntent | null {
  const allowed: VoiceDetectedIntent[] = ["task", "note", "meeting_candidate", "reminder_candidate"];
  if (typeof value !== "string") return null;
  return allowed.includes(value as VoiceDetectedIntent) ? (value as VoiceDetectedIntent) : null;
}

function hasCyrillic(value: string): boolean {
  return /[\u0400-\u04FF]/.test(value);
}

function localizedReasoningSummary(
  reasoning: string,
  input: { intent: VoiceDetectedIntent; confidence: number; dueHint: string | null; datetimeHint: string | null }
): string {
  if (hasCyrillic(reasoning)) return reasoning;
  const intentText: Record<VoiceDetectedIntent, string> = {
    task: "Схоже на окрему задачу.",
    note: "Схоже на нотатку.",
    meeting_candidate: "Схоже на кандидат зустрічі.",
    reminder_candidate: "Схоже на кандидат нагадування."
  };
  const hint = input.dueHint ?? input.datetimeHint;
  const confidenceText =
    input.confidence >= 0.8 ? "Висока впевненість." : input.confidence >= 0.55 ? "Середня впевненість." : "Низька впевненість, перевір вручну.";
  return `${intentText[input.intent]} ${hint ? `Часова підказка: ${hint}.` : "Явної часової підказки немає."} ${confidenceText}`.trim();
}

function formatDateTimeLabel(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("uk-UA", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function extractVoiceSuggestion(item: InboxItem): VoiceAiSuggestion | null {
  const meta = asRecord(item.meta);
  const voiceAi = asRecord(meta?.voice_ai);
  const parseSuggestion = asRecord(voiceAi?.parseSuggestion);
  if (!parseSuggestion) return null;

  const detectedIntent = toDetectedIntent(parseSuggestion.detectedIntent);
  const title = toNullableString(parseSuggestion.title);
  const details = toNullableString(parseSuggestion.details);
  const confidence = toNullableNumber(parseSuggestion.confidence);
  const reasoningSummary = toNullableString(parseSuggestion.reasoningSummary);

  if (!detectedIntent || !title || confidence === null || !reasoningSummary) return null;

  return {
    detectedIntent,
    title,
    details: details ?? "",
    projectGuess: toNullableString(parseSuggestion.projectGuess),
    taskTypeGuess: toTaskType(parseSuggestion.taskTypeGuess),
    importanceGuess: toNullableNumber(parseSuggestion.importanceGuess),
    dueHint: toNullableString(parseSuggestion.dueHint),
    datetimeHint: toNullableString(parseSuggestion.datetimeHint),
    dueAtIso: toNullableString(parseSuggestion.dueAtIso),
    scheduledForIso: toNullableString(parseSuggestion.scheduledForIso),
    confidence: Math.max(0, Math.min(1, confidence)),
    reasoningSummary: localizedReasoningSummary(reasoningSummary, {
      intent: detectedIntent,
      confidence: Math.max(0, Math.min(1, confidence)),
      dueHint: toNullableString(parseSuggestion.dueHint),
      datetimeHint: toNullableString(parseSuggestion.datetimeHint)
    })
  };
}

function toCandidateStatus(value: unknown): VoiceCandidateStatus {
  if (value === "confirmed" || value === "discarded") return value;
  return "pending";
}

function extractVoiceCandidates(item: InboxItem): VoiceAiCandidate[] {
  const meta = asRecord(item.meta);
  const voiceAi = asRecord(meta?.voice_ai);
  const rawCandidates = Array.isArray(voiceAi?.candidates) ? voiceAi.candidates : [];

  const fromCandidates = rawCandidates
    .map((raw, index): VoiceAiCandidate | null => {
      const parsed = asRecord(raw);
      if (!parsed) return null;
      const detectedIntent = toDetectedIntent(parsed.detectedIntent);
      const title = toNullableString(parsed.title);
      const confidence = toNullableNumber(parsed.confidence);
      const reasoningSummary = toNullableString(parsed.reasoningSummary);
      if (!detectedIntent || !title || confidence === null || !reasoningSummary) return null;
      return {
        candidateId: toNullableString(parsed.candidateId) ?? `legacy_${index + 1}`,
        detectedIntent,
        title,
        details: toNullableString(parsed.details) ?? "",
        projectGuess: toNullableString(parsed.projectGuess),
        taskTypeGuess: toTaskType(parsed.taskTypeGuess),
        importanceGuess: toNullableNumber(parsed.importanceGuess),
        dueHint: toNullableString(parsed.dueHint),
        datetimeHint: toNullableString(parsed.datetimeHint),
        dueAtIso: toNullableString(parsed.dueAtIso),
        scheduledForIso: toNullableString(parsed.scheduledForIso),
        confidence: Math.max(0, Math.min(1, confidence)),
        reasoningSummary: localizedReasoningSummary(reasoningSummary, {
          intent: detectedIntent,
          confidence: Math.max(0, Math.min(1, confidence)),
          dueHint: toNullableString(parsed.dueHint),
          datetimeHint: toNullableString(parsed.datetimeHint)
        }),
        status: toCandidateStatus(parsed.status),
        resolvedAt: toNullableString(parsed.resolvedAt),
        resolutionAction:
          parsed.resolutionAction === "task" ||
          parsed.resolutionAction === "note" ||
          parsed.resolutionAction === "calendar_event" ||
          parsed.resolutionAction === "discard"
            ? parsed.resolutionAction
            : null
      };
    })
    .filter((item): item is VoiceAiCandidate => Boolean(item))
    .slice(0, 5);

  if (fromCandidates.length > 0) return fromCandidates;

  const single = extractVoiceSuggestion(item);
  if (!single) return [];
  return [
    {
      ...single,
      candidateId: "single_legacy",
      status: "pending",
      resolvedAt: null,
      resolutionAction: null
    }
  ];
}

function extractVoiceMode(item: InboxItem): "single_item" | "multi_item" | null {
  const meta = asRecord(item.meta);
  const voiceAi = asRecord(meta?.voice_ai);
  const mode = toNullableString(voiceAi?.mode);
  if (mode === "single_item" || mode === "multi_item") return mode;
  return null;
}

function extractCandidateCountEstimated(item: InboxItem): number | null {
  const meta = asRecord(item.meta);
  const voiceAi = asRecord(meta?.voice_ai);
  const value = toNullableNumber(voiceAi?.candidateCountEstimated);
  if (value === null) return null;
  return Math.max(1, Math.round(value));
}

function extractProjectMatch(item: InboxItem): {
  status: "matched" | "suggested_only" | "none";
  matchedProjectId: string | null;
  matchedProjectName: string | null;
  score: number | null;
} | null {
  const meta = asRecord(item.meta);
  const voiceAi = asRecord(meta?.voice_ai);
  const projectMatch = asRecord(voiceAi?.projectMatch);
  if (!projectMatch) return null;

  const status = toNullableString(projectMatch.status);
  if (status !== "matched" && status !== "suggested_only" && status !== "none") return null;

  return {
    status,
    matchedProjectId: toNullableString(projectMatch.matchedProjectId),
    matchedProjectName: toNullableString(projectMatch.matchedProjectName),
    score: toNullableNumber(projectMatch.score)
  };
}

function extractVoiceStatuses(item: InboxItem): {
  transcriptStatus: string | null;
  parseStatus: string | null;
  transcriptError: string | null;
  parseError: string | null;
} {
  const meta = asRecord(item.meta);
  const voiceAi = asRecord(meta?.voice_ai);
  const transcript = asRecord(voiceAi?.transcript);
  const parse = asRecord(voiceAi?.parse);
  return {
    transcriptStatus: toNullableString(transcript?.status),
    parseStatus: toNullableString(parse?.status),
    transcriptError: toNullableString(transcript?.error),
    parseError: toNullableString(parse?.error)
  };
}

function mapInboxError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.code === "unauthorized") {
      return "Сесія завершилась. Натисни «Скинути сесію» і авторизуйся знову.";
    }
    if (error.code === "inbox_item_not_new") {
      return "Елемент вже оброблений в іншому запиті. Оновлюю список.";
    }
    if (error.code === "project_not_found") {
      return "Вибраний проєкт більше недоступний. Обери інший і спробуй ще раз.";
    }
    if (error.code === "invalid_importance") {
      return "Важливість має бути від 1 до 5.";
    }
    if (error.code === "invalid_due_at" || error.code === "invalid_scheduled_for") {
      return "Невалідна дата або час. Перевір формат і спробуй ще раз.";
    }
    if (error.code === "candidate_not_found" || error.code === "candidate_already_processed") {
      return "Кандидат уже оброблений або недоступний. Оновлюю Інбокс.";
    }
    if (error.code === "voice_candidates_not_found") {
      return "AI-кандидати не знайдені для цього голосового запису. Оброби елемент вручну.";
    }
    if (error.code === "calendar_not_connected") {
      return "Google Calendar не підключено. Відкрий вкладку «Календар» і підключи акаунт.";
    }
    if (error.code === "calendar_event_create_failed") {
      return "Не вдалося створити подію в Google Calendar. Спробуй ще раз.";
    }
    if (error.status === 0) {
      return "Немає з'єднання з сервером. Перевір інтернет і спробуй ще раз.";
    }
  }
  return fallback;
}

function intentLabel(intent: VoiceDetectedIntent): string {
  switch (intent) {
    case "task":
      return "Задача";
    case "note":
      return "Нотатка";
    case "meeting_candidate":
      return "Кандидат зустрічі";
    case "reminder_candidate":
      return "Кандидат нагадування";
  }
}

function taskTypeLabel(value: TaskType): string {
  switch (value) {
    case "deep_work":
      return "Глибока робота";
    case "quick_communication":
      return "Швидка комунікація";
    case "admin_operational":
      return "Операційне";
    case "recurring_essential":
      return "Регулярне важливе";
    case "personal_essential":
      return "Особисто важливе";
    case "someday":
      return "Колись";
  }
}

function candidateStatusLabel(status: VoiceCandidateStatus): string {
  if (status === "confirmed") return "Підтверджено";
  if (status === "discarded") return "Відхилено";
  return "Очікує обробки";
}

export function InboxPage() {
  const [authState, setAuthState] = useState<AuthState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<InboxItem[]>([]);
  const [loadingItems, setLoadingItems] = useState(false);
  const [manualInitData, setManualInitData] = useState("");
  const [sessionToken, setSessionToken] = useState<string>(localStorage.getItem(SESSION_KEY) ?? "");
  const [triageLoading, setTriageLoading] = useState(false);
  const [workingItemId, setWorkingItemId] = useState<string | null>(null);
  const [pendingTriage, setPendingTriage] = useState<{ item: InboxItem; mode: "task" | "note" } | null>(null);
  const [pendingVoiceConfirm, setPendingVoiceConfirm] = useState<VoiceConfirmState>(null);
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [calendarStatus, setCalendarStatus] = useState<GoogleCalendarStatus | null>(null);
  const inFlightTriageRef = useRef<Set<string>>(new Set());
  const diagnostics = useDiagnostics();

  const initDataRaw = useMemo(() => getTelegramInitDataRaw(), []);
  const preparedItems = useMemo<PreparedInboxItem[]>(
    () =>
      items.map((item) => ({
        item,
        suggestion: extractVoiceSuggestion(item),
        candidates: extractVoiceCandidates(item),
        parseMode: extractVoiceMode(item),
        candidateCountEstimated: extractCandidateCountEstimated(item),
        projectMatch: extractProjectMatch(item),
        statuses: extractVoiceStatuses(item),
        isVoiceItem: item.source_type === "voice"
      })),
    [items]
  );

  function invalidateSession() {
    localStorage.removeItem(SESSION_KEY);
    setSessionToken("");
    setAuthState("idle");
  }

  function resetSession() {
    localStorage.removeItem(SESSION_KEY);
    setSessionToken("");
    setItems([]);
    setProjects([]);
    setError(null);
    setAuthState("idle");

    if (initDataRaw) {
      void runAuth(initDataRaw);
    }
  }

  async function loadInbox(token: string) {
    setLoadingItems(true);
    diagnostics.trackAction("load_inbox", { route: "/" });
    try {
      const inboxItems = await getInbox(token);
      setItems(inboxItems);
      diagnostics.markRefresh();
      diagnostics.setScreenDataSource("inbox_data");
    } catch (loadError) {
      console.error("[inbox] load_failed", loadError);
      if (loadError instanceof ApiError) {
        diagnostics.trackFailure({
          path: loadError.path,
          status: loadError.status,
          code: loadError.code,
          message: loadError.message,
          details: loadError.details
        });
      }
      if (loadError instanceof ApiError && loadError.code === "unauthorized") {
        invalidateSession();
      }
      setError(mapInboxError(loadError, "Не вдалося завантажити Інбокс"));
    } finally {
      setLoadingItems(false);
    }
  }

  async function loadProjects(token: string) {
    try {
      const projectItems = await getProjects(token);
      setProjects(projectItems);
    } catch (error) {
      console.error("[inbox] projects_load_failed", error);
      if (error instanceof ApiError) {
        diagnostics.trackFailure({
          path: error.path,
          status: error.status,
          code: error.code,
          message: error.message,
          details: error.details
        });
      }
      setProjects([]);
    }
  }

  async function loadCalendarStatus(token: string) {
    try {
      const status = await getGoogleCalendarStatus(token);
      setCalendarStatus(status);
    } catch {
      setCalendarStatus(null);
    }
  }

  async function runAuth(initData: string) {
    setAuthState("authenticating");
    setError(null);
    diagnostics.trackAction("auth_telegram_start", { route: "/" });

    try {
      const session = await authTelegram(initData);
      localStorage.setItem(SESSION_KEY, session.token);
      setSessionToken(session.token);
      setAuthState("ready");
      diagnostics.trackAction("auth_telegram_success", { route: "/" });
      await Promise.all([loadInbox(session.token), loadProjects(session.token), loadCalendarStatus(session.token)]);
    } catch (authError) {
      console.error("[inbox] auth_failed", authError);
      if (authError instanceof ApiError) {
        diagnostics.trackFailure({
          path: authError.path,
          status: authError.status,
          code: authError.code,
          message: authError.message,
          details: authError.details
        });
      }
      setAuthState("error");
      setError(mapInboxError(authError, "Помилка авторизації"));
    }
  }

  useEffect(() => {
    window.Telegram?.WebApp?.ready?.();
    window.Telegram?.WebApp?.expand?.();

    const boot = async () => {
      if (sessionToken) {
        setAuthState("ready");
        await Promise.all([loadInbox(sessionToken), loadProjects(sessionToken), loadCalendarStatus(sessionToken)]);
        return;
      }

      if (initDataRaw) {
        await runAuth(initDataRaw);
      }
    };

    void boot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function markItemOptimisticTriaged(itemId: string) {
    setItems((prev) => prev.filter((item) => item.id !== itemId));
  }

  function beginTriage(itemId: string): boolean {
    if (inFlightTriageRef.current.has(itemId)) return false;
    inFlightTriageRef.current.add(itemId);
    setWorkingItemId(itemId);
    return true;
  }

  function endTriage(itemId: string) {
    inFlightTriageRef.current.delete(itemId);
    setWorkingItemId((current) => (current === itemId ? null : current));
  }

  async function handleTriage(item: InboxItem, action: "task" | "note" | "discard") {
    if (!sessionToken) return;
    if (!beginTriage(item.id)) return;
    diagnostics.trackAction(action === "discard" ? "discard_inbox_item" : "open_inbox_confirm", {
      itemId: item.id,
      action
    });

    setError(null);

    try {
      if (action === "discard") {
        await triageInboxItem({
          sessionToken,
          inboxItemId: item.id,
          action
        });
        markItemOptimisticTriaged(item.id);
        void loadInbox(sessionToken);
        return;
      }

      setPendingTriage({ item, mode: action });
      endTriage(item.id);
      return;
    } catch (triageError) {
      console.error("[inbox] triage_open_failed", { itemId: item.id, action, triageError });
      if (triageError instanceof ApiError) {
        diagnostics.trackFailure({
          path: triageError.path,
          status: triageError.status,
          code: triageError.code,
          message: triageError.message,
          details: triageError.details
        });
      }
      if (triageError instanceof ApiError && triageError.code === "unauthorized") {
        invalidateSession();
      }
      setError(mapInboxError(triageError, "Не вдалося обробити вхідний запис."));
    } finally {
      endTriage(item.id);
    }
  }

  async function confirmModalTriage(payload: {
    title?: string;
    noteBody?: string;
    dueAt?: string | null;
    scheduledFor?: string | null;
    estimatedMinutes?: number | null;
  }) {
    if (!sessionToken || !pendingTriage) return;
    if (!beginTriage(pendingTriage.item.id)) return;
    diagnostics.trackAction(pendingTriage.mode === "task" ? "confirm_as_task" : "confirm_as_note", {
      itemId: pendingTriage.item.id,
      mode: pendingTriage.mode
    });

    setTriageLoading(true);
    setError(null);

    try {
      await triageInboxItem({
        sessionToken,
        inboxItemId: pendingTriage.item.id,
        action: pendingTriage.mode,
        title: payload.title,
        noteBody: payload.noteBody
      });

      setPendingTriage(null);
      markItemOptimisticTriaged(pendingTriage.item.id);
      void loadInbox(sessionToken);
    } catch (triageError) {
      console.error("[inbox] triage_confirm_failed", {
        itemId: pendingTriage.item.id,
        mode: pendingTriage.mode,
        triageError
      });
      if (triageError instanceof ApiError) {
        diagnostics.trackFailure({
          path: triageError.path,
          status: triageError.status,
          code: triageError.code,
          message: triageError.message,
          details: triageError.details
        });
      }
      if (triageError instanceof ApiError && triageError.code === "unauthorized") {
        invalidateSession();
      }
      setError(mapInboxError(triageError, "Не вдалося зберегти зміни."));
    } finally {
      setTriageLoading(false);
      endTriage(pendingTriage.item.id);
    }
  }

  async function confirmVoiceTriage(payload: {
    targetKind: VoiceConfirmTargetKind;
    title: string;
    details: string;
    noteBody: string;
    projectId: string | null;
    taskType: TaskType | null;
    importance: number | null;
    dueAt: string | null;
    scheduledFor: string | null;
    timezone: string;
  }) {
    if (!sessionToken || !pendingVoiceConfirm) return;
    if (!beginTriage(pendingVoiceConfirm.item.id)) return;
    diagnostics.trackAction(
      payload.targetKind === "task"
        ? "confirm_voice_as_task"
        : payload.targetKind === "note"
        ? "confirm_voice_as_note"
        : "confirm_voice_as_calendar_event",
      { itemId: pendingVoiceConfirm.item.id, targetKind: payload.targetKind }
    );

    setTriageLoading(true);
    setError(null);
    try {
      if (pendingVoiceConfirm.candidateId) {
        const candidateAction =
          payload.targetKind === "task"
            ? "task"
            : payload.targetKind === "note"
            ? "note"
            : "calendar_event";
        const result = await resolveVoiceCandidate({
          sessionToken,
          inboxItemId: pendingVoiceConfirm.item.id,
          candidateId: pendingVoiceConfirm.candidateId,
          action: candidateAction,
          title: payload.title,
          details: payload.details,
          noteBody: payload.noteBody,
          projectId: payload.projectId ?? undefined,
          taskType: payload.taskType ?? undefined,
          importance: payload.importance ?? undefined,
          dueAt: payload.dueAt ?? undefined,
          scheduledFor: payload.scheduledFor ?? undefined,
          timezone: payload.timezone
        });
        setPendingVoiceConfirm(null);
        if (result.allProcessed) {
          markItemOptimisticTriaged(pendingVoiceConfirm.item.id);
        }
        void loadInbox(sessionToken);
      } else {
        if (payload.targetKind === "task") {
          await triageInboxItem({
            sessionToken,
            inboxItemId: pendingVoiceConfirm.item.id,
            action: "task",
            title: payload.title,
            details: payload.details,
            projectId: payload.projectId ?? undefined,
            taskType: payload.taskType ?? undefined,
            importance: payload.importance ?? undefined,
            dueAt: payload.dueAt ?? undefined,
            scheduledFor: payload.scheduledFor ?? undefined
          });
        } else if (payload.targetKind === "note") {
          await triageInboxItem({
            sessionToken,
            inboxItemId: pendingVoiceConfirm.item.id,
            action: "note",
            noteBody: payload.noteBody,
            projectId: payload.projectId ?? undefined
          });
        } else {
          if (!payload.scheduledFor) {
            throw new ApiError({
              status: 400,
              path: "/functions/v1/create-google-calendar-event",
              code: "missing_or_invalid_start",
              message: "Потрібно вказати початок події.",
              details: null
            });
          }
          await createGoogleCalendarEvent({
            sessionToken,
            sourceInboxItemId: pendingVoiceConfirm.item.id,
            title: payload.title || "Подія з голосового інбоксу",
            description: payload.details || pendingVoiceConfirm.item.transcript_text || undefined,
            startAt: payload.scheduledFor,
            endAt: payload.dueAt ?? null,
            timezone: payload.timezone || "UTC"
          });
          await triageInboxItem({
            sessionToken,
            inboxItemId: pendingVoiceConfirm.item.id,
            action: "discard"
          });
        }
        setPendingVoiceConfirm(null);
        markItemOptimisticTriaged(pendingVoiceConfirm.item.id);
        void loadInbox(sessionToken);
      }
    } catch (triageError) {
      console.error("[inbox] voice_confirm_failed", {
        itemId: pendingVoiceConfirm.item.id,
        payload,
        triageError
      });
      if (triageError instanceof ApiError) {
        diagnostics.trackFailure({
          path: triageError.path,
          status: triageError.status,
          code: triageError.code,
          message: triageError.message,
          details: triageError.details
        });
      }
      if (triageError instanceof ApiError && triageError.code === "unauthorized") {
        invalidateSession();
      }
      setError(mapInboxError(triageError, "Не вдалося підтвердити голосову пропозицію."));
    } finally {
      setTriageLoading(false);
      endTriage(pendingVoiceConfirm.item.id);
    }
  }

  async function discardVoiceCandidate(item: InboxItem, candidate: VoiceAiCandidate) {
    if (!sessionToken) return;
    if (!beginTriage(item.id)) return;
    setTriageLoading(true);
    setError(null);
    diagnostics.trackAction("discard_voice_candidate", {
      itemId: item.id,
      candidateId: candidate.candidateId
    });
    try {
      const result = await resolveVoiceCandidate({
        sessionToken,
        inboxItemId: item.id,
        candidateId: candidate.candidateId,
        action: "discard"
      });
      if (result.allProcessed) {
        markItemOptimisticTriaged(item.id);
      }
      void loadInbox(sessionToken);
    } catch (resolveError) {
      if (resolveError instanceof ApiError) {
        diagnostics.trackFailure({
          path: resolveError.path,
          status: resolveError.status,
          code: resolveError.code,
          message: resolveError.message,
          details: resolveError.details
        });
      }
      if (resolveError instanceof ApiError && resolveError.code === "unauthorized") {
        invalidateSession();
      }
      if (
        resolveError instanceof ApiError &&
        (resolveError.code === "candidate_not_found" || resolveError.code === "candidate_already_processed")
      ) {
        void loadInbox(sessionToken);
      }
      setError(mapInboxError(resolveError, "Не вдалося відхилити кандидат."));
    } finally {
      setTriageLoading(false);
      endTriage(item.id);
    }
  }

  return (
    <section className="panel">
      <h2>Інбокс</h2>
      <p>Черга вхідних записів з Telegram та Mini App.</p>
      {sessionToken ? (
        <div className="toolbar-row">
          <button onClick={resetSession}>Скинути сесію</button>
        </div>
      ) : null}

      {!initDataRaw && !sessionToken ? (
        <div className="dev-auth-box">
          <p className="empty-note">Не знайдено Telegram initData. Для локального тесту встав його вручну.</p>
          <textarea
            value={manualInitData}
            onChange={(event) => setManualInitData(event.target.value)}
            placeholder="Встав Telegram WebApp initData вручну"
            rows={4}
          />
          <button
            onClick={() => void runAuth(manualInitData.trim())}
            disabled={authState === "authenticating" || !manualInitData.trim()}
          >
            {authState === "authenticating" ? "Авторизація..." : "Авторизуватися"}
          </button>
        </div>
      ) : null}

      {error ? <p className="error-note">{error}</p> : null}

      {authState === "authenticating" ? <p>Авторизація...</p> : null}
      {loadingItems ? <p>Завантаження Інбоксу...</p> : null}

      {!loadingItems && preparedItems.length === 0 ? (
        <p className="empty-note">Інбокс порожній.</p>
      ) : (
        <ul className="inbox-list">
          {preparedItems.map(({ item, suggestion, candidates, parseMode, candidateCountEstimated, projectMatch, statuses, isVoiceItem }) => {
            const isBusyItem = triageLoading && workingItemId === item.id;
            const pendingCandidates = candidates.filter((candidate) => candidate.status === "pending");
            const processedCandidates = candidates.length - pendingCandidates.length;
            const hasCandidates = candidates.length > 0;

            return (
              <li key={item.id} className="inbox-item">
                <p className="inbox-main-text">{previewText(item)}</p>
                <p className="inbox-meta">
                  {sourceLabel(item)} · {new Date(item.captured_at).toLocaleString()}
                </p>

                {isVoiceItem ? (
                  <section className="voice-ai-card">
                    <p className="voice-ai-title">Голосовий AI-розбір</p>
                    {item.transcript_text ? (
                      <p className="inbox-meta">Транскрипт: {item.transcript_text.slice(0, 220)}</p>
                    ) : (
                      <p className="empty-note">Транскрипт поки недоступний.</p>
                    )}
                    {hasCandidates ? (
                      <>
                        <p className="inbox-meta voice-candidate-summary">
                          {parseMode === "multi_item" ? "Багатоелементний розбір" : "Одноелементний розбір"} · Знайдено:{" "}
                          {candidates.length}
                          {candidateCountEstimated && candidateCountEstimated > candidates.length
                            ? ` із ${candidateCountEstimated}+`
                            : ""}
                          {" · "}Очікують: {pendingCandidates.length} · Оброблено: {processedCandidates}
                        </p>
                        {candidateCountEstimated && candidateCountEstimated > candidates.length ? (
                          <p className="inbox-meta">Показано лише найчіткіші кандидати. Повний транскрипт збережено вище.</p>
                        ) : null}
                        <ul className="inbox-list">
                          {candidates.map((candidate) => {
                            const canCreateCalendar =
                              (candidate.detectedIntent === "meeting_candidate" ||
                                candidate.detectedIntent === "reminder_candidate") &&
                              Boolean(calendarStatus?.connected);
                            return (
                              <li key={`${item.id}_${candidate.candidateId}`} className="inbox-item">
                                <p className="inbox-main-text">
                                  {candidate.title} ({intentLabel(candidate.detectedIntent)})
                                </p>
                                <p className="inbox-meta">
                                  {candidateStatusLabel(candidate.status)} · Впевненість: {Math.round(candidate.confidence * 100)}%
                                </p>
                                {candidate.projectGuess ? <p className="inbox-meta">Проєкт: {candidate.projectGuess}</p> : null}
                                {candidate.taskTypeGuess ? (
                                  <p className="inbox-meta">Тип задачі: {taskTypeLabel(candidate.taskTypeGuess)}</p>
                                ) : null}
                                {candidate.importanceGuess ? (
                                  <p className="inbox-meta">Важливість: {candidate.importanceGuess}/5</p>
                                ) : null}
                                {candidate.dueHint || candidate.datetimeHint ? (
                                  <p className="inbox-meta">Підказка часу: {candidate.dueHint ?? candidate.datetimeHint}</p>
                                ) : null}
                                {candidate.scheduledForIso ? (
                                  <p className="inbox-meta">Заплановано: {formatDateTimeLabel(candidate.scheduledForIso) ?? "невизначено"}</p>
                                ) : null}
                                {candidate.dueAtIso ? (
                                  <p className="inbox-meta">Дедлайн: {formatDateTimeLabel(candidate.dueAtIso) ?? "невизначено"}</p>
                                ) : null}
                                <p className="inbox-meta">Пояснення: {candidate.reasoningSummary}</p>
                                {candidate.status === "pending" ? (
                                  <div className="inbox-actions">
                                    <button
                                      onClick={() => {
                                        diagnostics.trackAction("open_voice_confirm", {
                                          itemId: item.id,
                                          candidateId: candidate.candidateId,
                                          defaultKind: "task"
                                        });
                                        setPendingVoiceConfirm({
                                          item,
                                          candidateId: candidate.candidateId,
                                          defaultKind: "task",
                                          suggestion: candidate,
                                          projectMatch
                                        });
                                      }}
                                      disabled={isBusyItem}
                                    >
                                      Підтвердити / редагувати
                                    </button>
                                    <button
                                      onClick={() => {
                                        diagnostics.trackAction("open_voice_confirm", {
                                          itemId: item.id,
                                          candidateId: candidate.candidateId,
                                          defaultKind: "note"
                                        });
                                        setPendingVoiceConfirm({
                                          item,
                                          candidateId: candidate.candidateId,
                                          defaultKind: "note",
                                          suggestion: candidate,
                                          projectMatch
                                        });
                                      }}
                                      disabled={isBusyItem}
                                    >
                                      У нотатку
                                    </button>
                                    {canCreateCalendar ? (
                                      <button
                                        onClick={() => {
                                          diagnostics.trackAction("open_voice_confirm", {
                                            itemId: item.id,
                                            candidateId: candidate.candidateId,
                                            defaultKind: "calendar_event"
                                          });
                                          setPendingVoiceConfirm({
                                            item,
                                            candidateId: candidate.candidateId,
                                            defaultKind: "calendar_event",
                                            suggestion: candidate,
                                            projectMatch
                                          });
                                        }}
                                        disabled={isBusyItem}
                                      >
                                        У Google Calendar
                                      </button>
                                    ) : null}
                                    <button
                                      className="danger"
                                      onClick={() => void discardVoiceCandidate(item, candidate)}
                                      disabled={isBusyItem}
                                    >
                                      Відхилити кандидат
                                    </button>
                                  </div>
                                ) : (
                                  <p className="inbox-meta">Кандидат вже оброблено.</p>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      </>
                    ) : suggestion ? (
                      <>
                        <p className="inbox-meta">
                          Інтент: {intentLabel(suggestion.detectedIntent)} · Впевненість:{" "}
                          {Math.round(suggestion.confidence * 100)}%
                        </p>
                        {suggestion.detectedIntent === "meeting_candidate" ||
                        suggestion.detectedIntent === "reminder_candidate" ? (
                          <>
                            <p className="inbox-meta">
                              Це лише пропозиція. Подія в календар не створюється автоматично.
                            </p>
                            {!calendarStatus?.connected ? (
                              <p className="inbox-meta">Щоб створити подію, спочатку підключи Google Calendar на вкладці «Календар».</p>
                            ) : null}
                          </>
                        ) : null}
                        <p className="inbox-meta">Назва: {suggestion.title}</p>
                        {suggestion.projectGuess ? <p className="inbox-meta">Проєкт: {suggestion.projectGuess}</p> : null}
                        {projectMatch?.status === "matched" ? (
                          <p className="inbox-meta">
                            Зіставлено з проєктом: {projectMatch.matchedProjectName ?? "невідомо"}
                            {typeof projectMatch.score === "number"
                              ? ` (${Math.round(projectMatch.score * 100)}%)`
                              : ""}
                          </p>
                        ) : null}
                        {suggestion.taskTypeGuess ? (
                          <p className="inbox-meta">Тип задачі: {taskTypeLabel(suggestion.taskTypeGuess)}</p>
                        ) : null}
                        {suggestion.importanceGuess ? (
                          <p className="inbox-meta">Важливість: {suggestion.importanceGuess}/5</p>
                        ) : null}
                        {suggestion.dueHint || suggestion.datetimeHint ? (
                          <p className="inbox-meta">Підказка часу: {suggestion.dueHint ?? suggestion.datetimeHint}</p>
                        ) : null}
                        {suggestion.scheduledForIso ? (
                          <p className="inbox-meta">Заплановано: {formatDateTimeLabel(suggestion.scheduledForIso) ?? "невизначено"}</p>
                        ) : null}
                        {suggestion.dueAtIso ? (
                          <p className="inbox-meta">Дедлайн: {formatDateTimeLabel(suggestion.dueAtIso) ?? "невизначено"}</p>
                        ) : null}
                        <p className="inbox-meta">Пояснення: {suggestion.reasoningSummary}</p>
                        <div className="inbox-actions">
                          <button
                            onClick={() => {
                              diagnostics.trackAction("open_voice_confirm", {
                                itemId: item.id,
                                defaultKind: "task"
                              });
                              setPendingVoiceConfirm({
                                item,
                                candidateId: null,
                                defaultKind: "task",
                                suggestion,
                                projectMatch
                              });
                            }}
                            disabled={isBusyItem}
                          >
                            Підтвердити / редагувати
                          </button>
                          <button
                            onClick={() => {
                              diagnostics.trackAction("open_voice_confirm", {
                                itemId: item.id,
                                defaultKind: "note"
                              });
                              setPendingVoiceConfirm({
                                item,
                                candidateId: null,
                                defaultKind: "note",
                                suggestion,
                                projectMatch
                              });
                            }}
                            disabled={isBusyItem}
                          >
                            У нотатку
                          </button>
                          {(suggestion.detectedIntent === "meeting_candidate" ||
                            suggestion.detectedIntent === "reminder_candidate") &&
                          calendarStatus?.connected ? (
                            <button
                              onClick={() => {
                                diagnostics.trackAction("open_voice_confirm", {
                                  itemId: item.id,
                                  defaultKind: "calendar_event"
                                });
                                setPendingVoiceConfirm({
                                  item,
                                  candidateId: null,
                                  defaultKind: "calendar_event",
                                  suggestion,
                                  projectMatch
                                });
                              }}
                              disabled={isBusyItem}
                            >
                              У Google Calendar
                            </button>
                          ) : null}
                          <button
                            className="danger"
                            onClick={() => void handleTriage(item, "discard")}
                            disabled={isBusyItem}
                          >
                            Відхилити
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <p className="empty-note">
                          AI-розбір недоступний ({statuses.parseStatus ?? "невідомо"}). Оброби вручну.
                        </p>
                        <div className="inbox-actions">
                          <button onClick={() => void handleTriage(item, "task")} disabled={isBusyItem}>
                            У задачу
                          </button>
                          <button onClick={() => void handleTriage(item, "note")} disabled={isBusyItem}>
                            У нотатку
                          </button>
                          <button className="danger" onClick={() => void handleTriage(item, "discard")} disabled={isBusyItem}>
                            Відхилити
                          </button>
                        </div>
                      </>
                    )}
                    <p className="inbox-meta">
                      Статус транскрипції: {statuses.transcriptStatus ?? "нема"} · Статус розбору:{" "}
                      {statuses.parseStatus ?? "нема"}
                    </p>
                    {statuses.transcriptError ? (
                      <p className="inbox-meta">Помилка транскрипції: {statuses.transcriptError}</p>
                    ) : null}
                    {statuses.parseError ? <p className="inbox-meta">Помилка розбору: {statuses.parseError}</p> : null}
                  </section>
                ) : (
                  <div className="inbox-actions">
                    <button onClick={() => void handleTriage(item, "task")} disabled={isBusyItem}>
                      У задачу
                    </button>
                    <button onClick={() => void handleTriage(item, "note")} disabled={isBusyItem}>
                      У нотатку
                    </button>
                    <button className="danger" onClick={() => void handleTriage(item, "discard")} disabled={isBusyItem}>
                      Відхилити
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <InboxTriageModal
        open={Boolean(pendingTriage)}
        mode={pendingTriage?.mode ?? null}
        sourceText={pendingTriage ? previewText(pendingTriage.item) : ""}
        busy={triageLoading}
        onCancel={() => setPendingTriage(null)}
        onConfirm={(payload) => {
          void confirmModalTriage(payload);
        }}
      />

      <VoiceConfirmModal
        open={Boolean(pendingVoiceConfirm)}
        contextId={
          pendingVoiceConfirm
            ? `${pendingVoiceConfirm.item.id}:${pendingVoiceConfirm.candidateId ?? "single"}`
            : null
        }
        defaultKind={pendingVoiceConfirm?.defaultKind ?? "task"}
        allowCalendarEvent={
          (pendingVoiceConfirm?.suggestion.detectedIntent === "meeting_candidate" ||
            pendingVoiceConfirm?.suggestion.detectedIntent === "reminder_candidate") &&
          Boolean(calendarStatus?.connected)
        }
        suggestion={pendingVoiceConfirm?.suggestion ?? null}
        projectMatch={pendingVoiceConfirm?.projectMatch ?? null}
        projects={projects}
        transcript={pendingVoiceConfirm?.item.transcript_text ?? ""}
        busy={triageLoading}
        errorMessage={pendingVoiceConfirm ? error : null}
        onCancel={() => setPendingVoiceConfirm(null)}
        onConfirm={(payload) => {
          void confirmVoiceTriage(payload);
        }}
      />
    </section>
  );
}






