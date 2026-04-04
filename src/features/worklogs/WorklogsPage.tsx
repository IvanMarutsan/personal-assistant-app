import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useDiagnostics } from "../../lib/diagnostics";
import { ApiError, createWorklog, getProjects, getWorklogs } from "../../lib/api";
import type { ProjectItem, WorklogItem } from "../../types/api";

const SESSION_KEY = "personal_assistant_app_session_token";

function projectName(item: WorklogItem): string {
  if (!item.projects) return "Без проєкту";
  if (Array.isArray(item.projects)) return item.projects[0]?.name ?? "Без проєкту";
  return item.projects.name ?? "Без проєкту";
}

function formatOccurredAt(value: string): string {
  return new Date(value).toLocaleString();
}

export function WorklogsPage() {
  const [items, setItems] = useState<WorklogItem[]>([]);
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [body, setBody] = useState("");
  const [projectId, setProjectId] = useState("");
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

  const hasItems = useMemo(() => items.length > 0, [items]);

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

      {loading ? <p>Завантаження контексту...</p> : null}
      {!loading && !hasItems ? <p className="empty-note">Контекстних записів поки немає.</p> : null}

      {hasItems ? (
        <ul className="inbox-list">
          {items.map((item) => (
            <li key={item.id} className="inbox-item">
              <p className="inbox-meta">
                {projectName(item)} · сталося: {formatOccurredAt(item.occurred_at)}
              </p>
              <p className="worklog-entry-body">{item.body}</p>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
