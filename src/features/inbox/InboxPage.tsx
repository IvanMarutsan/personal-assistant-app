import { useEffect, useMemo, useRef, useState } from "react";
import { InboxTriageModal } from "../../components/InboxTriageModal";
import { VoiceConfirmModal } from "../../components/VoiceConfirmModal";
import { useDiagnostics } from "../../lib/diagnostics";
import { ApiError, authTelegram, getInbox, getProjects, getTelegramInitDataRaw, triageInboxItem } from "../../lib/api";
import type { InboxItem, ProjectItem, TaskType, VoiceAiSuggestion, VoiceDetectedIntent } from "../../types/api";

const SESSION_KEY = "personal_assistant_app_session_token";

type AuthState = "idle" | "authenticating" | "ready" | "error";

type VoiceConfirmState = {
  item: InboxItem;
  defaultKind: "task" | "note";
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
  return `${channel} / ${source}`;
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
    reasoningSummary
  };
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
  const inFlightTriageRef = useRef<Set<string>>(new Set());
  const diagnostics = useDiagnostics();

  const initDataRaw = useMemo(() => getTelegramInitDataRaw(), []);
  const preparedItems = useMemo<PreparedInboxItem[]>(
    () =>
      items.map((item) => ({
        item,
        suggestion: extractVoiceSuggestion(item),
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
      setError(mapInboxError(loadError, "Не вдалося завантажити Inbox"));
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
      await Promise.all([loadInbox(session.token), loadProjects(session.token)]);
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
        await Promise.all([loadInbox(sessionToken), loadProjects(sessionToken)]);
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

  async function confirmModalTriage(payload: { title?: string; noteBody?: string }) {
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
    targetKind: "task" | "note";
    title: string;
    details: string;
    noteBody: string;
    projectId: string | null;
    taskType: TaskType | null;
    importance: number | null;
    dueAt: string | null;
    scheduledFor: string | null;
  }) {
    if (!sessionToken || !pendingVoiceConfirm) return;
    if (!beginTriage(pendingVoiceConfirm.item.id)) return;
    diagnostics.trackAction(
      payload.targetKind === "task" ? "confirm_voice_as_task" : "confirm_voice_as_note",
      { itemId: pendingVoiceConfirm.item.id, targetKind: payload.targetKind }
    );

    setTriageLoading(true);
    setError(null);
    try {
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
      } else {
        await triageInboxItem({
          sessionToken,
          inboxItemId: pendingVoiceConfirm.item.id,
          action: "note",
          noteBody: payload.noteBody,
          projectId: payload.projectId ?? undefined
        });
      }
      setPendingVoiceConfirm(null);
      markItemOptimisticTriaged(pendingVoiceConfirm.item.id);
      void loadInbox(sessionToken);
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

  return (
    <section className="panel">
      <h2>Inbox</h2>
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
            placeholder="Встав Telegram WebApp initData"
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
      {loadingItems ? <p>Завантаження Inbox...</p> : null}

      {!loadingItems && preparedItems.length === 0 ? (
        <p className="empty-note">Inbox порожній.</p>
      ) : (
        <ul className="inbox-list">
          {preparedItems.map(({ item, suggestion, projectMatch, statuses, isVoiceItem }) => {
            const isBusyItem = triageLoading && workingItemId === item.id;

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
                    {suggestion ? (
                      <>
                        <p className="inbox-meta">
                          Інтент: {intentLabel(suggestion.detectedIntent)} · Впевненість:{" "}
                          {Math.round(suggestion.confidence * 100)}%
                        </p>
                        {suggestion.detectedIntent === "meeting_candidate" ||
                        suggestion.detectedIntent === "reminder_candidate" ? (
                          <p className="inbox-meta">
                            Це лише пропозиція. Подія в календар не створюється автоматично.
                          </p>
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
                          <p className="inbox-meta">
                            Часовий hint: {suggestion.dueHint ?? suggestion.datetimeHint}
                          </p>
                        ) : null}
                        {suggestion.scheduledForIso || suggestion.dueAtIso ? (
                          <p className="inbox-meta">
                            Час (ISO): {suggestion.scheduledForIso ?? "—"} / дедлайн {suggestion.dueAtIso ?? "—"}
                          </p>
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
                                defaultKind: "note",
                                suggestion,
                                projectMatch
                              });
                            }}
                            disabled={isBusyItem}
                          >
                            У нотатку
                          </button>
                          <button type="button" className="ghost" disabled>
                            Залишити в Inbox
                          </button>
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
        defaultKind={pendingVoiceConfirm?.defaultKind ?? "task"}
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
