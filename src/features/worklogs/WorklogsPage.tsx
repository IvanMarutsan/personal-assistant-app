import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useDiagnostics } from "../../lib/diagnostics";
import { ApiError, createWorklog, getProjects, getWorklogs } from "../../lib/api";
import type { ProjectItem, WorklogItem } from "../../types/api";

const SESSION_KEY = "personal_assistant_app_session_token";

type InsightsRange = "today" | "last7days";

function projectName(item: WorklogItem): string {
  if (!item.projects) return "Без проєкту";
  if (Array.isArray(item.projects)) return item.projects[0]?.name ?? "Без проєкту";
  return item.projects.name ?? "Без проєкту";
}

function formatOccurredAt(value: string): string {
  return new Intl.DateTimeFormat("uk-UA", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function sourceLabel(value: string | null): string {
  if (value === "manual") return "Вручну";
  if (value === "voice_candidate") return "З голосу";
  if (value === "inbox") return "З інбоксу";
  if (value === "inbox_triage") return "З інбоксу";
  return "Інше";
}

function dayLabel(value: string): string {
  return new Intl.DateTimeFormat("uk-UA", {
    day: "2-digit",
    month: "short"
  }).format(new Date(value));
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function WorklogsPage() {
  const [items, setItems] = useState<WorklogItem[]>([]);
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [body, setBody] = useState("");
  const [projectId, setProjectId] = useState("");
  const [range, setRange] = useState<InsightsRange>("today");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const diagnostics = useDiagnostics();
  const sessionToken = localStorage.getItem(SESSION_KEY) ?? "";

  async function loadWorklogs() {
    if (!sessionToken) {
      setItems([]);
      return;
    }

    setLoading(true);
    setError(null);
    diagnostics.trackAction("load_worklogs", { route: "/worklogs" });

    try {
      const worklogs = await getWorklogs(sessionToken);
      setItems(worklogs);
      diagnostics.markRefresh();
      diagnostics.setScreenDataSource("worklogs_data");
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
      setError(loadError instanceof Error ? loadError.message : "Не вдалося завантажити контекстні записи");
    } finally {
      setLoading(false);
    }
  }

  async function loadProjects() {
    if (!sessionToken) {
      setProjects([]);
      return;
    }

    try {
      const projectItems = await getProjects(sessionToken);
      setProjects(projectItems.filter((item) => item.status !== "archived"));
    } catch {
      setProjects([]);
    }
  }

  useEffect(() => {
    void Promise.all([loadWorklogs(), loadProjects()]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const now = useMemo(() => new Date(), []);
  const rangeStart = useMemo(() => {
    const todayStart = startOfDay(now);
    if (range === "today") return todayStart;
    const value = new Date(todayStart);
    value.setDate(value.getDate() - 6);
    return value;
  }, [now, range]);

  const filteredItems = useMemo(
    () => items.filter((item) => new Date(item.occurred_at).getTime() >= rangeStart.getTime()),
    [items, rangeStart]
  );

  const hasItems = useMemo(() => items.length > 0, [items]);

  const insights = useMemo(() => {
    const byProject = new Map<string, number>();
    const bySource = new Map<string, number>();
    const byDay = new Map<string, number>();
    let withoutProject = 0;

    for (const item of filteredItems) {
      const project = projectName(item);
      if (project === "Без проєкту") {
        withoutProject += 1;
      } else {
        byProject.set(project, (byProject.get(project) ?? 0) + 1);
      }

      const source = sourceLabel(item.source);
      bySource.set(source, (bySource.get(source) ?? 0) + 1);

      const day = item.occurred_at.slice(0, 10);
      if (day) byDay.set(day, (byDay.get(day) ?? 0) + 1);
    }

    return {
      total: filteredItems.length,
      withoutProject,
      byProject: Array.from(byProject.entries())
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "uk"))
        .slice(0, 5),
      bySource: Array.from(bySource.entries())
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "uk")),
      byDay: Array.from(byDay.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .slice(-7)
    };
  }, [filteredItems]);

  async function submitWorklog(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!sessionToken || !body.trim()) return;

    setSaving(true);
    setError(null);
    diagnostics.trackAction("create_worklog", { hasProject: !!projectId });

    try {
      const created = await createWorklog({
        sessionToken,
        body,
        projectId: projectId || null,
        source: "manual"
      });
      setItems((current) => [created, ...current]);
      setBody("");
      setProjectId("");
      diagnostics.markRefresh();
    } catch (saveError) {
      if (saveError instanceof ApiError) {
        diagnostics.trackFailure({
          path: saveError.path,
          status: saveError.status,
          code: saveError.code,
          message: saveError.message,
          details: saveError.details
        });
      }
      setError(saveError instanceof Error ? saveError.message : "Не вдалося зберегти контекстний запис");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel">
      <h2>Контекст</h2>
      <p>Короткі фактичні оновлення про перебіг дня без створення нових задач.</p>

      {!sessionToken ? <p className="empty-note">Відкрий Інбокс для авторизації сесії.</p> : null}
      {error ? <p className="error-note">{error}</p> : null}

      {sessionToken ? (
        <form className="worklog-form" onSubmit={(event) => void submitWorklog(event)}>
          <label>
            Що сталося
            <textarea
              rows={4}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder="Наприклад: відповів на кілька термінових повідомлень і швидко закрив дрібну проблему"
            />
          </label>

          <label>
            Проєкт
            <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
              <option value="">Без проєкту</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>

          <div className="worklog-form-actions">
            <button type="submit" disabled={saving || !body.trim()}>
              {saving ? "Зберігаємо..." : "Зберегти запис"}
            </button>
          </div>
        </form>
      ) : null}

      {sessionToken ? (
        <section className="panel" style={{ marginTop: 16 }}>
          <div className="toolbar-row">
            <button type="button" className={range === "today" ? "" : "ghost"} onClick={() => setRange("today")}>
              За сьогодні
            </button>
            <button type="button" className={range === "last7days" ? "" : "ghost"} onClick={() => setRange("last7days")}>
              За 7 днів
            </button>
          </div>

          <p className="inbox-meta">
            {range === "today" ? `За сьогодні: ${insights.total} записів` : `За 7 днів: ${insights.total} записів`}
          </p>
          <p className="inbox-meta">Без проєкту: {insights.withoutProject}</p>

          {insights.byProject.length > 0 ? (
            <div>
              <p className="inbox-main-text">Найчастіше згадувані проєкти</p>
              {insights.byProject.map(([name, count]) => (
                <p key={name} className="inbox-meta">
                  {name}: {count}
                </p>
              ))}
            </div>
          ) : null}

          {insights.bySource.length > 0 ? (
            <div>
              <p className="inbox-main-text">Джерела записів</p>
              {insights.bySource.map(([name, count]) => (
                <p key={name} className="inbox-meta">
                  {name}: {count}
                </p>
              ))}
            </div>
          ) : null}

          {range === "last7days" && insights.byDay.length > 0 ? (
            <div>
              <p className="inbox-main-text">Розподіл по днях</p>
              {insights.byDay.map(([day, count]) => (
                <p key={day} className="inbox-meta">
                  {dayLabel(day)}: {count}
                </p>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {loading ? <p>Завантаження контексту...</p> : null}
      {!loading && !hasItems ? <p className="empty-note">Контекстних записів поки немає.</p> : null}

      {hasItems ? (
        <ul className="inbox-list">
          {items.map((item) => (
            <li key={item.id} className="inbox-item">
              <p className="inbox-meta">
                {projectName(item)} · сталося: {formatOccurredAt(item.occurred_at)} · {sourceLabel(item.source)}
              </p>
              <p className="worklog-entry-body">{item.body}</p>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
