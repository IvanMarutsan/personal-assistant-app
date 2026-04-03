import { useEffect, useMemo, useState } from "react";
import { useDiagnostics } from "../../lib/diagnostics";
import {
  ApiError,
  getGoogleCalendarStatus,
  getGoogleCalendarUpcoming,
  startGoogleCalendarConnect
} from "../../lib/api";
import type { GoogleCalendarEventItem, GoogleCalendarStatus } from "../../types/api";

const SESSION_KEY = "personal_assistant_app_session_token";

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return new Intl.DateTimeFormat("uk-UA", {
    dateStyle: "short",
    timeStyle: "short"
  }).format(d);
}

function mapCalendarError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.code === "calendar_not_connected") {
      return "Google Calendar ще не підключено.";
    }
    if (error.code === "calendar_auth_expired") {
      return "Сесія Google Calendar застаріла. Натисни «Перепідключити Google Calendar».";
    }
    if (error.code === "calendar_permission_denied") {
      return "Немає доступу до подій календаря. Перепідключи Google Calendar і підтвердь усі дозволи.";
    }
    if (error.code === "calendar_not_found") {
      return "Основний календар не знайдено. Спробуй перепідключення Google Calendar.";
    }
    if (error.code === "calendar_upcoming_fetch_failed") {
      return "Не вдалося завантажити найближчі події. Спробуй оновити або перепідключити Google Calendar.";
    }
    if (error.code === "unauthorized") {
      return "Сесія недійсна. Перейди в Inbox і авторизуйся знову.";
    }
    return error.message || fallback;
  }
  if (error instanceof Error) return error.message;
  return fallback;
}

export function CalendarPage() {
  const diagnostics = useDiagnostics();
  const sessionToken = localStorage.getItem(SESSION_KEY) ?? "";

  const [status, setStatus] = useState<GoogleCalendarStatus | null>(null);
  const [events, setEvents] = useState<GoogleCalendarEventItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [connectLoading, setConnectLoading] = useState(false);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [authUrlCopied, setAuthUrlCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connectHint = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    const marker = params.get("calendar_connect");
    const reason = params.get("reason");
    if (marker === "success") return "Google Calendar успішно підключено.";
    if (marker === "error") return `Підключення Google Calendar не вдалося${reason ? ` (${reason})` : ""}.`;
    return null;
  }, []);

  async function loadCalendarData() {
    if (!sessionToken) {
      setStatus(null);
      setEvents([]);
      return;
    }

    setLoading(true);
    setError(null);
    diagnostics.trackAction("load_calendar", { route: "/calendar" });
    try {
      const calendarStatus = await getGoogleCalendarStatus(sessionToken);
      setStatus(calendarStatus);
      if (!calendarStatus.connected) {
        setEvents([]);
      } else {
        const upcoming = await getGoogleCalendarUpcoming(sessionToken);
        setEvents(upcoming);
      }
      diagnostics.markRefresh();
      diagnostics.setScreenDataSource("calendar_data");
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
      setError(mapCalendarError(loadError, "Не вдалося завантажити дані календаря."));
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
      setError("Спочатку авторизуйся в Inbox.");
      return;
    }

    setConnectLoading(true);
    setError(null);
    setAuthUrlCopied(false);
    diagnostics.trackAction("start_google_calendar_connect", { route: "/calendar" });
    try {
      const result = await startGoogleCalendarConnect({
        sessionToken,
        returnPath: "/calendar"
      });
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
      setError("Не вдалося скопіювати посилання. Спробуй відкрити в браузері.");
    }
  }

  return (
    <section className="panel">
      <h2>Календар</h2>
      <p>Підключи Google Calendar, переглядай найближчі події й створюй нові події вручну.</p>

      {!sessionToken ? <p className="empty-note">Відкрий Inbox для авторизації сесії.</p> : null}
      {connectHint ? <p className="inbox-meta">{connectHint}</p> : null}
      {error ? <p className="error-note">{error}</p> : null}
      {loading ? <p>Завантаження календаря...</p> : null}

      <div className="toolbar-row">
        <button type="button" onClick={() => void startConnect()} disabled={connectLoading || !sessionToken}>
          {connectLoading
            ? "Підготовка підключення..."
            : status?.connected
            ? "Перепідключити Google Calendar"
            : "Підключити Google Calendar"}
        </button>
        <button type="button" className="ghost" onClick={() => void loadCalendarData()} disabled={loading || !sessionToken}>
          Оновити
        </button>
      </div>

      {authUrl ? (
        <section className="project-group">
          <h3>Підключення Google (через зовнішній браузер)</h3>
          <p className="inbox-meta">
            Google не дозволяє OAuth у Telegram WebView. Відкрий авторизацію у зовнішньому браузері.
          </p>
          <div className="toolbar-row">
            <button type="button" onClick={openAuthInBrowser}>
              Відкрити авторизацію в браузері
            </button>
            <button type="button" className="ghost" onClick={() => void copyAuthUrl()}>
              Скопіювати посилання
            </button>
          </div>
          {authUrlCopied ? <p className="inbox-meta">Посилання скопійовано.</p> : null}
        </section>
      ) : null}

      <section className="project-group">
        <h3>Статус підключення</h3>
        {!status ? (
          <p className="empty-note">Немає даних.</p>
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
        <h3>Найближчі події</h3>
        {status && !status.connected ? (
          <p className="empty-note">Підключи Google Calendar, щоб бачити події.</p>
        ) : events.length === 0 ? (
          <p className="empty-note">Подій не знайдено.</p>
        ) : (
          <ul className="inbox-list">
            {events.map((event) => (
              <li className="inbox-item" key={event.id}>
                <p className="inbox-main-text">{event.title}</p>
                <p className="inbox-meta">
                  {formatDateTime(event.startAt)} → {formatDateTime(event.endAt)}
                </p>
                {event.description ? <p className="inbox-meta">{event.description}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
