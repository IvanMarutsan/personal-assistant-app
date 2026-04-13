import { useEffect, useMemo, useState } from "react";
import { CalendarEventModal } from "../../components/CalendarEventModal";
import { useDiagnostics } from "../../lib/diagnostics";
import {
  ApiError,
  deleteCalendarBlock,
  getCalendarBlocks,
  getGoogleCalendarStatus,
  getProjects,
  startGoogleCalendarConnect,
  upsertCalendarBlock
} from "../../lib/api";
import type { CalendarBlockItem, GoogleCalendarStatus, ProjectItem } from "../../types/api";

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

export function CalendarPage() {
  const diagnostics = useDiagnostics();
  const sessionToken = localStorage.getItem(SESSION_KEY) ?? "";

  const [status, setStatus] = useState<GoogleCalendarStatus | null>(null);
  const [blocks, setBlocks] = useState<CalendarBlockItem[]>([]);
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [activeBlock, setActiveBlock] = useState<CalendarBlockItem | null>(null);
  const [blockEditorOpen, setBlockEditorOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [connectLoading, setConnectLoading] = useState(false);
  const [blockBusy, setBlockBusy] = useState(false);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [authUrlCopied, setAuthUrlCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blockError, setBlockError] = useState<string | null>(null);

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

  async function saveBlock(input: { title: string; description: string; startAt: string; endAt: string | null; timezone: string; projectId: string | null }) {
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
        projectId: input.projectId
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
    const confirmed = window.confirm("Видалити цей блок із календаря?");
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
            <p className="inbox-meta">Календар: {status.calendarId ?? "primary"}</p>
          </>
        ) : (
          <p className="empty-note">Google Calendar не підключено.</p>
        )}
      </section>

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
                <p className="inbox-main-text">{block.title}</p>
                <p className="inbox-meta">{formatBlockRange(block)}</p>
                <p className="inbox-meta block-row__meta">{sourceLabel(block)} · Проєкт: {blockProjectName(block)}</p>
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

