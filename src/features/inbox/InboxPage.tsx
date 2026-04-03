import { useEffect, useMemo, useState } from "react";
import { InboxTriageModal } from "../../components/InboxTriageModal";
import { VoiceConfirmModal } from "../../components/VoiceConfirmModal";
import { authTelegram, getInbox, getProjects, getTelegramInitDataRaw, triageInboxItem } from "../../lib/api";
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

function previewText(item: InboxItem): string {
  return item.raw_text ?? item.transcript_text ?? "(voice placeholder)";
}

function sourceLabel(item: InboxItem): string {
  return `${item.source_channel} / ${item.source_type}`;
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

function extractVoiceStatuses(item: InboxItem): { transcriptStatus: string | null; parseStatus: string | null } {
  const meta = asRecord(item.meta);
  const voiceAi = asRecord(meta?.voice_ai);
  const transcript = asRecord(voiceAi?.transcript);
  const parse = asRecord(voiceAi?.parse);
  return {
    transcriptStatus: toNullableString(transcript?.status),
    parseStatus: toNullableString(parse?.status)
  };
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
  const [pendingTriage, setPendingTriage] = useState<{ item: InboxItem; mode: "task" | "note" } | null>(null);
  const [pendingVoiceConfirm, setPendingVoiceConfirm] = useState<VoiceConfirmState>(null);
  const [projects, setProjects] = useState<ProjectItem[]>([]);

  const initDataRaw = useMemo(() => getTelegramInitDataRaw(), []);

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
    try {
      const inboxItems = await getInbox(token);
      setItems(inboxItems);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Не вдалося завантажити Inbox");
    } finally {
      setLoadingItems(false);
    }
  }

  async function loadProjects(token: string) {
    try {
      const projectItems = await getProjects(token);
      setProjects(projectItems);
    } catch {
      setProjects([]);
    }
  }

  async function runAuth(initData: string) {
    setAuthState("authenticating");
    setError(null);

    try {
      const session = await authTelegram(initData);
      localStorage.setItem(SESSION_KEY, session.token);
      setSessionToken(session.token);
      setAuthState("ready");
      await Promise.all([loadInbox(session.token), loadProjects(session.token)]);
    } catch (authError) {
      setAuthState("error");
      setError(authError instanceof Error ? authError.message : "Помилка авторизації");
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

  async function handleTriage(item: InboxItem, action: "task" | "note" | "discard") {
    if (!sessionToken) return;

    setError(null);

    try {
      if (action === "discard") {
        await triageInboxItem({
          sessionToken,
          inboxItemId: item.id,
          action
        });
        await loadInbox(sessionToken);
        return;
      }

      setPendingTriage({ item, mode: action });
    } catch (triageError) {
      setError(triageError instanceof Error ? triageError.message : "Не вдалося обробити inbox item");
    }
  }

  async function confirmModalTriage(payload: { title?: string; noteBody?: string }) {
    if (!sessionToken || !pendingTriage) return;

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
      await loadInbox(sessionToken);
    } catch (triageError) {
      setError(triageError instanceof Error ? triageError.message : "Не вдалося обробити inbox item");
    } finally {
      setTriageLoading(false);
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
      await loadInbox(sessionToken);
    } catch (triageError) {
      setError(triageError instanceof Error ? triageError.message : "Не вдалося підтвердити голосову пропозицію");
    } finally {
      setTriageLoading(false);
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

      {!loadingItems && items.length === 0 ? (
        <p className="empty-note">Inbox порожній.</p>
      ) : (
        <ul className="inbox-list">
          {items.map((item) => {
            const suggestion = extractVoiceSuggestion(item);
            const projectMatch = extractProjectMatch(item);
            const statuses = extractVoiceStatuses(item);
            const isVoiceItem = item.source_type === "voice";

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
                            onClick={() =>
                              setPendingVoiceConfirm({
                                item,
                                defaultKind: "task",
                                suggestion,
                                projectMatch
                              })
                            }
                          >
                            Підтвердити / редагувати
                          </button>
                          <button
                            onClick={() =>
                              setPendingVoiceConfirm({
                                item,
                                defaultKind: "note",
                                suggestion,
                                projectMatch
                              })
                            }
                          >
                            У нотатку
                          </button>
                          <button type="button" className="ghost" disabled>
                            Залишити в Inbox
                          </button>
                          <button className="danger" onClick={() => void handleTriage(item, "discard")}>
                            Відхилити
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <p className="empty-note">
                          AI-розбір недоступний ({statuses.parseStatus ?? "unknown"}). Оброби вручну.
                        </p>
                        <div className="inbox-actions">
                          <button onClick={() => void handleTriage(item, "task")}>У задачу</button>
                          <button onClick={() => void handleTriage(item, "note")}>У нотатку</button>
                          <button className="danger" onClick={() => void handleTriage(item, "discard")}>
                            Відхилити
                          </button>
                        </div>
                      </>
                    )}
                    <p className="inbox-meta">
                      Transcript status: {statuses.transcriptStatus ?? "n/a"} · Parse status: {statuses.parseStatus ?? "n/a"}
                    </p>
                  </section>
                ) : (
                  <div className="inbox-actions">
                    <button onClick={() => void handleTriage(item, "task")}>У задачу</button>
                    <button onClick={() => void handleTriage(item, "note")}>У нотатку</button>
                    <button className="danger" onClick={() => void handleTriage(item, "discard")}>
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
        onCancel={() => setPendingVoiceConfirm(null)}
        onConfirm={(payload) => {
          void confirmVoiceTriage(payload);
        }}
      />
    </section>
  );
}
