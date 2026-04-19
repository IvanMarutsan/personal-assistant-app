import { useEffect, useMemo, useState } from "react";
import { CalendarEventModal } from "../../components/CalendarEventModal";
import { useDiagnostics } from "../../lib/diagnostics";
import { recurrenceLabel } from "../../lib/recurrence";
import {
  ApiError,
  deleteCalendarBlock,
  getCalendarBlocks,
  getGoogleIntegrationPreferences,
  getGoogleCalendarStatus,
  getProjects,
  startGoogleCalendarConnect,
  updateGoogleIntegrationPreferences,
  upsertCalendarBlock
} from "../../lib/api";
import type { CalendarBlockItem, GoogleCalendarStatus, GoogleIntegrationPreferences, ProjectItem } from "../../types/api";

const SESSION_KEY = "personal_assistant_app_session_token";

function formatDateTime(value: string | null, isAllDay = false): string {
  if (!value) return "Без часу";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  if (isAllDay) {
    return new Intl.DateTimeFormat("uk-UA", { dateStyle: "short" }).format(d);
  }
  return new Intl.DateTimeFormat("uk-UA", {
    dateStyle: "short",
    timeStyle: "short"
  }).format(d);
}

function formatBlockRange(block: CalendarBlockItem): string {
  if (block.is_all_day) return `Увесь день · ${formatDateTime(block.start_at, true)}`;
  return `${formatDateTime(block.start_at)} - ${formatDateTime(block.end_at)}`;
}

function blockProjectName(block: CalendarBlockItem): string {
  if (!block.projects) return "Без проєкту";
  if (Array.isArray(block.projects)) return block.projects[0]?.name ?? "Без проєкту";
  return block.projects.name ?? "Без проєкту";
}

function sourceLabel(block: CalendarBlockItem): string {
  return block.source === "app" ? "Створено в додатку" : "Подія з Google Calendar";
}

function calendarDisplayName(preferences: GoogleIntegrationPreferences | null, calendarId: string | null | undefined): string {
  if (!calendarId) return "primary";
  const match = preferences?.calendars.find((item) => item.id === calendarId);
  return match?.summary ?? calendarId;
}

function taskListDisplayName(preferences: GoogleIntegrationPreferences | null, listId: string | null | undefined): string {
  if (!listId || listId === "@default") return "Основний список";
  const match = preferences?.taskLists.find((item) => item.id === listId);
  return match?.title ?? listId;
}

function mapCalendarError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.code === "calendar_not_connected") return "Google Calendar ще не підключено.";
    if (error.code === "calendar_auth_expired") return "Доступ до Google Calendar завершився. Перепідключи календар.";
    if (error.code === "calendar_permission_denied") return "Немає доступу до календаря. Перевір підключення Google Calendar.";
    if (error.code === "calendar_not_found") return "Подію не знайдено. Спробуй пересинхронізувати календар.";
    if (error.code === "unauthorized") return "Сесію завершено. Авторизуйся знову в додатку.";
    if (error.code === "calendar_block_all_day_read_only") return "Події на весь день поки що можна редагувати тільки в Google Calendar.";
    return error.message || fallback;
  }
  if (error instanceof Error) return error.message;
  return fallback;
}

function oauthReasonLabel(reason: string | null): string {
  if (!reason) return "Календар підключено.";
  if (reason === "invalid_or_expired_state") return "Спроба підключення застаріла. Запусти її ще раз у Mini App.";
  if (reason === "missing_code_or_state") return "Google не повернув потрібні дані для підключення.";
  if (reason === "google_oauth_callback_failed") return "Не вдалося завершити підключення Google.";
  if (reason.startsWith("oauth_")) return "Google повернув помилку під час підключення.";
  return "Підключення Google Calendar не вдалося.";
}

function googleTasksRecoveryHint(input: {
  tasksScopeAvailable: boolean;
  tasksAccessState?: GoogleIntegrationPreferences["tasksAccessState"] | GoogleCalendarStatus["tasksAccessState"];
  tasksAccessError?: string | null;
}): string | null {
  if (input.tasksScopeAvailable) return "Google Tasks доступні.";
  if (input.tasksAccessState === "scope_missing") {
    return "Google підключено для календарів, але без дозволу на Google Tasks. Перепідключи акаунт.";
  }
  if (input.tasksAccessError === "google_tasks_api_disabled") {
    return "Google Calendar підключено, але в поточному Google Cloud проєкті Tasks API вимкнений або недоступний. Це вже не лікується простим перепідключенням у Mini App.";
  }
  if (input.tasksAccessError === "google_tasks_insufficient_permissions") {
    return "Google повертає недостатні права саме для Tasks API. Спробуй перепідключення ще раз; якщо стан лишається, проблема вже на стороні Google інтеграції.";
  }
  if (input.tasksAccessState === "permission_denied") {
    return "Google календарі підключено, але Google відхиляє доступ саме до Tasks API. Якщо перепідключення не допомагає, проблема вже на стороні Google інтеграції.";
  }
  if (input.tasksAccessState === "auth_expired") {
    return "Доступ до Google Tasks завершився. Перепідключи акаунт.";
  }
  return "Google Tasks зараз недоступні.";
}

export function CalendarPage() {
  const diagnostics = useDiagnostics();
  const sessionToken = localStorage.getItem(SESSION_KEY) ?? "";

  const [status, setStatus] = useState<GoogleCalendarStatus | null>(null);
  const [blocks, setBlocks] = useState<CalendarBlockItem[]>([]);
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [integrationPreferences, setIntegrationPreferences] = useState<GoogleIntegrationPreferences | null>(null);
  const [activeBlock, setActiveBlock] = useState<CalendarBlockItem | null>(null);
  const [blockEditorOpen, setBlockEditorOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [connectLoading, setConnectLoading] = useState(false);
  const [blockBusy, setBlockBusy] = useState(false);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [authUrlCopied, setAuthUrlCopied] = useState(false);
  const [preferencesBusy, setPreferencesBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blockError, setBlockError] = useState<string | null>(null);

  const effectiveTasksAccessState = integrationPreferences?.tasksAccessState ?? status?.tasksAccessState;
  const effectiveTasksAccessError =
    integrationPreferences?.tasksAccessError === "google_tasks_permission_denied" && status?.tasksAccessError
      ? status.tasksAccessError
      : integrationPreferences?.tasksAccessError ?? status?.tasksAccessError ?? null;

  const connectHint = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    const marker = params.get("calendar_connect");
    const reason = params.get("reason");
    if (marker === "success") return "Google Calendar успішно підключено.";
    if (marker === "error") return oauthReasonLabel(reason);
    return null;
  }, []);

  async function loadCalendarData() {
    if (!sessionToken) {
      setStatus(null);
      setBlocks([]);
      setProjects([]);
      return;
    }

    setLoading(true);
    setError(null);
    diagnostics.trackAction("load_calendar", { route: "/calendar" });
    try {
      const [calendarStatus, projectItems] = await Promise.all([
        getGoogleCalendarStatus(sessionToken),
        getProjects(sessionToken)
      ]);
      setStatus(calendarStatus);
      setProjects(projectItems);
      if (calendarStatus.connected) {
        const prefs = await getGoogleIntegrationPreferences(sessionToken);
        setIntegrationPreferences(prefs);
      } else {
        setIntegrationPreferences(null);
      }
      if (!calendarStatus.connected) {
        setBlocks([]);
      } else {
        const now = new Date();
        const timeMin = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
        const timeMax = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
        const upcoming = await getCalendarBlocks({ sessionToken, timeMin, timeMax, maxResults: 120 });
        setBlocks(upcoming);
      }
      diagnostics.markRefresh();
      diagnostics.setScreenDataSource("calendar_blocks");
    } catch (loadError) {
      if (loadError instanceof ApiError) {
        diagnostics.trackFailure({
          path: loadError.path,
          status: loadError.status,
          code: loadError.code,
          message: loadError.message,
          details: loadError.details
        });
      }
      setError(mapCalendarError(loadError, "Не вдалося завантажити блоки календаря."));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadCalendarData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionToken]);

  useEffect(() => {
    if (!connectHint) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("calendar_connect");
    url.searchParams.delete("reason");
    window.history.replaceState({}, "", url.toString());
  }, [connectHint]);

  async function startConnect() {
    if (!sessionToken) {
      setError("Спочатку авторизуйся в додатку.");
      return;
    }

    setConnectLoading(true);
    setError(null);
    setAuthUrlCopied(false);
    diagnostics.trackAction("start_google_calendar_connect", { route: "/calendar" });
    try {
      const result = await startGoogleCalendarConnect({ sessionToken, returnPath: "/calendar" });
      setAuthUrl(result.authUrl);
    } catch (connectError) {
      if (connectError instanceof ApiError) {
        diagnostics.trackFailure({
          path: connectError.path,
          status: connectError.status,
          code: connectError.code,
          message: connectError.message,
          details: connectError.details
        });
      }
      setError(mapCalendarError(connectError, "Не вдалося почати підключення Google Calendar."));
    } finally {
      setConnectLoading(false);
    }
  }

  async function saveIntegrationPreferences(next: {
    selectedCalendarIds: string[];
    defaultCalendarId: string | null;
    defaultTaskListId?: string | null;
  }) {
    if (!sessionToken) return;
    setPreferencesBusy(true);
    setError(null);
    try {
      const updated = await updateGoogleIntegrationPreferences({
        sessionToken,
        selectedCalendarIds: next.selectedCalendarIds,
        defaultCalendarId: next.defaultCalendarId,
        defaultTaskListId: next.defaultTaskListId ?? null
      });
      setIntegrationPreferences((current) =>
        current
          ? {
              ...current,
              selectedCalendarIds: updated.selectedCalendarIds,
              defaultCalendarId: updated.defaultCalendarId,
              defaultTaskListId: updated.defaultTaskListId,
              calendars: current.calendars.map((item) => ({
                ...item,
                selected: updated.selectedCalendarIds.includes(item.id),
                default: updated.defaultCalendarId === item.id
              })),
              taskLists: current.taskLists.map((item) => ({
                ...item,
                isDefault: updated.defaultTaskListId === item.id
              }))
            }
          : current
      );
      await loadCalendarData();
    } catch (preferencesError) {
      setError(mapCalendarError(preferencesError, "Не вдалося зберегти налаштування календарів."));
    } finally {
      setPreferencesBusy(false);
    }
  }

  function openAuthInBrowser() {
    if (!authUrl) return;
    diagnostics.trackAction("open_google_connect_external", { route: "/calendar" });
    try {
      if (window.Telegram?.WebApp?.openLink) {
        window.Telegram.WebApp.openLink(authUrl);
        return;
      }
      window.open(authUrl, "_blank", "noopener,noreferrer");
    } catch {
      window.location.href = authUrl;
    }
  }

  async function copyAuthUrl() {
    if (!authUrl) return;
    try {
      await navigator.clipboard.writeText(authUrl);
      setAuthUrlCopied(true);
      setError(null);
    } catch {
      setError("Не вдалося скопіювати посилання. Спробуй відкрити його вручну.");
    }
  }

  async function saveBlock(input: {
    title: string;
    description: string;
    startAt: string;
    endAt: string | null;
    timezone: string;
    projectId: string | null;
    recurrenceFrequency: "daily" | "weekly" | "monthly" | null;
  }) {
    if (!sessionToken || !input.endAt) return;
    setBlockBusy(true);
    setBlockError(null);
    try {
      await upsertCalendarBlock({
        sessionToken,
        id: activeBlock?.id ?? null,
        title: input.title,
        details: input.description,
        startAt: input.startAt,
        endAt: input.endAt,
        timezone: input.timezone,
        projectId: input.projectId,
        recurrenceFrequency: input.recurrenceFrequency
      });
      setBlockEditorOpen(false);
      setActiveBlock(null);
      await loadCalendarData();
    } catch (saveError) {
      setBlockError(mapCalendarError(saveError, "Не вдалося зберегти блок у календарі."));
    } finally {
      setBlockBusy(false);
    }
  }

  async function removeBlock() {
    if (!sessionToken || !activeBlock) return;
    const confirmed = window.confirm(activeBlock?.recurrence_rule ? "Видалити лише цей повтор із календаря?" : "Видалити цей блок із календаря?");
    if (!confirmed) return;
    setBlockBusy(true);
    setBlockError(null);
    try {
      await deleteCalendarBlock({ sessionToken, id: activeBlock.id });
      setBlockEditorOpen(false);
      setActiveBlock(null);
      await loadCalendarData();
    } catch (deleteError) {
      setBlockError(mapCalendarError(deleteError, "Не вдалося видалити блок із календаря."));
    } finally {
      setBlockBusy(false);
    }
  }

  return (
    <section className="panel">
      <h2>Календар</h2>
      <p>Тут зібрані часові блоки й події, які можна відкривати, редагувати й тримати в sync із Google Calendar.</p>

      {!sessionToken ? <p className="empty-note">Потрібна сесія для доступу до календаря.</p> : null}
      {connectHint ? <p className="inbox-meta">{connectHint}</p> : null}
      {error ? <p className="error-note">{error}</p> : null}
      {loading ? <p>Завантаження календаря...</p> : null}

      <div className="toolbar-row">
        <button type="button" onClick={() => void startConnect()} disabled={connectLoading || !sessionToken}>
          {connectLoading ? "Підключення..." : status?.connected ? "Перепідключити Google Calendar" : "Підключити Google Calendar"}
        </button>
        <button type="button" className="ghost" onClick={() => void loadCalendarData()} disabled={loading || !sessionToken}>
          Оновити
        </button>
        <button
          type="button"
          onClick={() => {
            setActiveBlock(null);
            setBlockError(null);
            setBlockEditorOpen(true);
          }}
          disabled={!sessionToken || !status?.connected || loading || blockBusy}
        >
          Створити блок
        </button>
      </div>

      {authUrl ? (
        <section className="project-group">
          <h3>Підключення Google (зовнішнє вікно)</h3>
          <p className="inbox-meta">Google не завершує OAuth у Telegram WebView. Відкрий підключення в браузері.</p>
          <div className="toolbar-row">
            <button type="button" onClick={openAuthInBrowser}>Відкрити підключення в браузері</button>
            <button type="button" className="ghost" onClick={() => void copyAuthUrl()}>Скопіювати посилання</button>
          </div>
          {authUrlCopied ? <p className="inbox-meta">Посилання скопійовано.</p> : null}
        </section>
      ) : null}

      <section className="project-group">
        <h3>Стан підключення</h3>
        {!status ? (
          <p className="empty-note">Статус ще не завантажено.</p>
        ) : status.connected ? (
          <>
            <p className="inbox-meta">Підключено: так</p>
            <p className="inbox-meta">Акаунт: {status.email ?? "невідомо"}</p>
            <p className="inbox-meta">Календар за замовчуванням: {calendarDisplayName(integrationPreferences, status.defaultCalendarId ?? status.calendarId)}</p>
            <p className="inbox-meta">Видимі календарі: {integrationPreferences?.selectedCalendarIds.length ?? status.selectedCalendarIds.length}</p>
            <p className="inbox-meta">Google Tasks за замовчуванням: {taskListDisplayName(integrationPreferences, status.defaultTaskListId)}</p>
            <p className="inbox-meta">Google Tasks: {googleTasksRecoveryHint({ tasksScopeAvailable: status.tasksScopeAvailable, tasksAccessState: status.tasksAccessState, tasksAccessError: status.tasksAccessError })}</p>
          </>
        ) : (
          <p className="empty-note">Google Calendar не підключено.</p>
        )}
      </section>

      {status?.connected && integrationPreferences ? (
        <section className="project-group">
          <h3>Що бачити й куди створювати</h3>
          <p className="inbox-meta">Познач, які Google Calendar треба читати в додатку, і вибери календар за замовчуванням для нових блоків.</p>
          <div className="inbox-list">
            {integrationPreferences.calendars.map((calendar) => (
              <label key={calendar.id} className="inbox-item">
                <div className="toolbar-row">
                  <input
                    type="checkbox"
                    checked={integrationPreferences.selectedCalendarIds.includes(calendar.id)}
                    disabled={
                      preferencesBusy ||
                      (integrationPreferences.selectedCalendarIds.length === 1 &&
                        integrationPreferences.selectedCalendarIds.includes(calendar.id))
                    }
                    onChange={(event) => {
                      const nextSelected = event.target.checked
                        ? Array.from(new Set([...integrationPreferences.selectedCalendarIds, calendar.id]))
                        : integrationPreferences.selectedCalendarIds.filter((id) => id !== calendar.id);
                      const nextDefault = nextSelected.includes(integrationPreferences.defaultCalendarId ?? "")
                        ? integrationPreferences.defaultCalendarId
                        : nextSelected[0] ?? null;
                      void saveIntegrationPreferences({
                        selectedCalendarIds: nextSelected,
                        defaultCalendarId: nextDefault,
                        defaultTaskListId: integrationPreferences.defaultTaskListId
                      });
                    }}
                  />
                  <div>
                    <p className="inbox-main-text">{calendar.summary}</p>
                    <p className="inbox-meta">
                      {calendar.primary ? "Основний календар" : "Додатковий календар"}
                      {calendar.default ? " · за замовчуванням" : ""}
                    </p>
                  </div>
                </div>
              </label>
            ))}
          </div>
          <label>
            Календар за замовчуванням для нових блоків
            <select
              value={integrationPreferences.defaultCalendarId ?? ""}
              disabled={preferencesBusy || integrationPreferences.selectedCalendarIds.length === 0}
              onChange={(event) => {
                void saveIntegrationPreferences({
                  selectedCalendarIds: integrationPreferences.selectedCalendarIds,
                  defaultCalendarId: event.target.value || null,
                  defaultTaskListId: integrationPreferences.defaultTaskListId
                });
              }}
            >
              {integrationPreferences.calendars
                .filter((calendar) => integrationPreferences.selectedCalendarIds.includes(calendar.id))
                .map((calendar) => (
                  <option key={calendar.id} value={calendar.id}>
                    {calendar.summary}
                  </option>
                ))}
            </select>
          </label>
          {integrationPreferences.tasksScopeAvailable && integrationPreferences.taskLists.length > 0 ? (
            <label>
              Список Google Tasks за замовчуванням
              <select
                value={integrationPreferences.defaultTaskListId ?? "@default"}
                disabled={preferencesBusy}
                onChange={(event) => {
                  void saveIntegrationPreferences({
                    selectedCalendarIds: integrationPreferences.selectedCalendarIds,
                    defaultCalendarId: integrationPreferences.defaultCalendarId,
                    defaultTaskListId: event.target.value || "@default"
                  });
                }}
              >
                {integrationPreferences.taskLists.map((taskList) => (
                  <option key={taskList.id} value={taskList.id}>
                    {taskList.title}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="inbox-meta">
              {googleTasksRecoveryHint({
                tasksScopeAvailable: integrationPreferences.tasksScopeAvailable,
                tasksAccessState: effectiveTasksAccessState,
                tasksAccessError: effectiveTasksAccessError
              }) ?? "Google Tasks поки що використовує основний список за замовчуванням."}
            </p>
          )}
        </section>
      ) : null}

      <section className="project-group">
        <h3>Найближчі блоки та події</h3>
        {status && !status.connected ? (
          <p className="empty-note">Підключи Google Calendar, щоб бачити й редагувати блоки.</p>
        ) : blocks.length === 0 ? (
          <p className="empty-note">Поки блоків небагато. Можна створити перший блок прямо тут або підтягнути події з Google Calendar.</p>
        ) : (
          <ul className="inbox-list">
            {blocks.map((block) => (
              <li className="inbox-item block-row" key={block.id}>
                <p className="inbox-main-text">
                  {block.title}
                  {block.recurrence_rule ? <span className="recurrence-badge">{recurrenceLabel(block.recurrence_rule)}</span> : null}
                </p>
                <p className="inbox-meta">{formatBlockRange(block)}</p>
                <p className="inbox-meta block-row__meta">{sourceLabel(block)} · Календар: {calendarDisplayName(integrationPreferences, block.provider_calendar_id)} · Проєкт: {blockProjectName(block)}</p>
                {block.recurrence_rule ? <p className="inbox-meta">Зараз відкривається лише цей повтор, не вся серія.</p> : null}
                {block.details ? <p className="inbox-meta">{block.details}</p> : null}
                <div className="inbox-actions">
                  <button
                    type="button"
                    onClick={() => {
                      setActiveBlock(block);
                      setBlockError(null);
                      setBlockEditorOpen(true);
                    }}
                  >
                    Відкрити
                  </button>
                  {block.provider_event_url ? (
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => {
                        if (window.Telegram?.WebApp?.openLink) {
                          window.Telegram.WebApp.openLink(block.provider_event_url!);
                          return;
                        }
                        window.open(block.provider_event_url!, "_blank", "noopener,noreferrer");
                      }}
                    >
                      Google Calendar
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <CalendarEventModal
        open={blockEditorOpen}
        titleHint={activeBlock?.title ?? ""}
        detailsHint={activeBlock?.details ?? ""}
        startHint={activeBlock?.start_at ?? new Date().toISOString()}
        endHint={activeBlock?.end_at ?? new Date(Date.now() + 60 * 60 * 1000).toISOString()}
        projectIdHint={activeBlock?.project_id ?? null}
        recurrenceRuleHint={activeBlock?.recurrence_rule ?? null}
        recurrenceTimezoneHint={activeBlock?.recurrence_timezone ?? null}
        projectOptions={projects}
        heading={activeBlock ? "Редагування блоку" : "Новий блок"}
        subtitle={
          activeBlock
            ? activeBlock.source === "google"
              ? "Подія прийшла з Google Calendar, але її можна редагувати прямо тут."
              : "Блок створено в додатку й синхронізовано з Google Calendar."
            : "Новий блок одразу збережеться в календарі й буде доступний для подальшого редагування тут."
        }
        confirmLabel={activeBlock ? "Зберегти зміни" : "Створити блок"}
        deleteLabel="Видалити блок"
        readOnlyReason={activeBlock?.is_all_day ? "Події на весь день поки що можна редагувати тільки в Google Calendar. Тут їх можна лише переглянути." : null}
        busy={blockBusy}
        errorMessage={blockError}
        onCancel={() => {
          if (blockBusy) return;
          setBlockEditorOpen(false);
          setActiveBlock(null);
          setBlockError(null);
        }}
        onDelete={activeBlock ? () => void removeBlock() : undefined}
        onConfirm={(payload) => {
          void saveBlock(payload);
        }}
      />
    </section>
  );
}

