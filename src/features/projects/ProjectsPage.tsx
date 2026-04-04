import { useEffect, useMemo, useState } from "react";
import { useDiagnostics } from "../../lib/diagnostics";
import { ApiError, createProject, getProjects, updateProject } from "../../lib/api";
import type { ProjectItem } from "../../types/api";

const SESSION_KEY = "personal_assistant_app_session_token";

type ProjectStatus = "active" | "on_hold" | "archived";

function statusLabel(status: ProjectStatus): string {
  if (status === "active") return "Активний";
  if (status === "on_hold") return "На паузі";
  return "Архів";
}

function formatAliases(aliases: string[]): string {
  return aliases.join(", ");
}

function parseAliases(raw: string): string[] {
  const parts = raw
    .split(/[\n,]+/)
    .map((item) => item.trim().replace(/\s+/g, " "))
    .filter(Boolean);

  const seen = new Set<string>();
  const result: string[] = [];
  for (const alias of parts) {
    const normalized = alias
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}\s]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(alias.slice(0, 100));
    if (result.length >= 12) break;
  }
  return result;
}

export function ProjectsPage() {
  const [items, setItems] = useState<ProjectItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [workingProjectId, setWorkingProjectId] = useState<string | null>(null);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [editingAliases, setEditingAliases] = useState("");
  const diagnostics = useDiagnostics();
  const sessionToken = localStorage.getItem(SESSION_KEY) ?? "";

  async function loadProjects() {
    if (!sessionToken) {
      setItems([]);
      return;
    }

    setLoading(true);
    setError(null);
    diagnostics.trackAction("load_projects_page", { route: "/projects" });
    try {
      const projects = await getProjects(sessionToken, { includeArchived: true });
      setItems(projects);
      diagnostics.markRefresh();
      diagnostics.setScreenDataSource("projects_data");
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
      setError(loadError instanceof Error ? loadError.message : "Не вдалося завантажити проєкти.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadProjects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const active = useMemo(() => items.filter((project) => project.status === "active"), [items]);
  const onHold = useMemo(() => items.filter((project) => project.status === "on_hold"), [items]);
  const archived = useMemo(() => items.filter((project) => project.status === "archived"), [items]);

  async function handleCreateProject() {
    if (!sessionToken) return;
    const name = newName.trim();
    if (!name) return;

    setWorkingProjectId("create");
    setError(null);
    diagnostics.trackAction("create_project", { route: "/projects" });
    try {
      await createProject({ sessionToken, name });
      setNewName("");
      await loadProjects();
    } catch (createError) {
      if (createError instanceof ApiError) {
        diagnostics.trackFailure({
          path: createError.path,
          status: createError.status,
          code: createError.code,
          message: createError.message,
          details: createError.details
        });
      }
      setError(createError instanceof Error ? createError.message : "Не вдалося створити проєкт.");
    } finally {
      setWorkingProjectId(null);
    }
  }

  function beginEdit(project: ProjectItem) {
    setEditingProjectId(project.id);
    setEditingName(project.name);
    setEditingAliases(formatAliases(project.aliases));
  }

  async function handleSaveProject(project: ProjectItem) {
    if (!sessionToken) return;
    const nextName = editingName.trim();
    const nextAliases = parseAliases(editingAliases);
    const sameName = nextName === project.name;
    const sameAliases = JSON.stringify(nextAliases) === JSON.stringify(project.aliases);

    if (!nextName) {
      setError("Назва проєкту не може бути порожньою.");
      return;
    }

    if (sameName && sameAliases) {
      setEditingProjectId(null);
      setEditingName("");
      setEditingAliases("");
      return;
    }

    setWorkingProjectId(project.id);
    setError(null);
    diagnostics.trackAction("update_project_details", { route: "/projects", projectId: project.id });
    try {
      await updateProject({
        sessionToken,
        projectId: project.id,
        name: nextName,
        aliases: nextAliases
      });
      setEditingProjectId(null);
      setEditingName("");
      setEditingAliases("");
      await loadProjects();
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
      setError(saveError instanceof Error ? saveError.message : "Не вдалося оновити проєкт.");
    } finally {
      setWorkingProjectId(null);
    }
  }

  async function handleSetStatus(project: ProjectItem, status: ProjectStatus) {
    if (!sessionToken || project.status === status) return;

    setWorkingProjectId(project.id);
    setError(null);
    diagnostics.trackAction("update_project_status", {
      route: "/projects",
      projectId: project.id,
      status
    });
    try {
      await updateProject({
        sessionToken,
        projectId: project.id,
        status
      });
      await loadProjects();
    } catch (statusError) {
      if (statusError instanceof ApiError) {
        diagnostics.trackFailure({
          path: statusError.path,
          status: statusError.status,
          code: statusError.code,
          message: statusError.message,
          details: statusError.details
        });
      }
      setError(statusError instanceof Error ? statusError.message : "Не вдалося оновити статус проєкту.");
    } finally {
      setWorkingProjectId(null);
    }
  }

  const renderList = (title: string, list: ProjectItem[]) => (
    <section className="project-group">
      <h3>{title}</h3>
      {list.length === 0 ? (
        <p className="empty-note">Немає проєктів.</p>
      ) : (
        <ul className="inbox-list">
          {list.map((project) => {
            const busy = loading || workingProjectId === project.id;
            const isEditing = editingProjectId === project.id;
            return (
              <li key={project.id} className="inbox-item">
                {isEditing ? (
                  <>
                    <label>
                      Назва
                      <input
                        value={editingName}
                        onChange={(event) => setEditingName(event.target.value)}
                        disabled={busy}
                      />
                    </label>
                    <label>
                      Відомі назви
                      <input
                        value={editingAliases}
                        onChange={(event) => setEditingAliases(event.target.value)}
                        placeholder="WOD, What's on DK, Whats on DK"
                        disabled={busy}
                      />
                    </label>
                    <p className="inbox-meta">Через кому. Потрібно для голосу й capture.</p>
                  </>
                ) : (
                  <>
                    <p className="inbox-main-text">{project.name}</p>
                    <p className="inbox-meta">Статус: {statusLabel(project.status)} · Ранг: {project.rank}</p>
                    <p className="inbox-meta">
                      Відомі назви: {project.aliases.length > 0 ? formatAliases(project.aliases) : "Не вказано"}
                    </p>
                  </>
                )}
                <div className="inbox-actions">
                  {isEditing ? (
                    <>
                      <button type="button" onClick={() => void handleSaveProject(project)} disabled={busy || !editingName.trim()}>
                        Зберегти
                      </button>
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => {
                          setEditingProjectId(null);
                          setEditingName("");
                          setEditingAliases("");
                        }}
                        disabled={busy}
                      >
                        Скасувати
                      </button>
                    </>
                  ) : (
                    <button type="button" className="ghost" onClick={() => beginEdit(project)} disabled={busy}>
                      Редагувати
                    </button>
                  )}
                  {project.status !== "active" ? (
                    <button type="button" className="ghost" onClick={() => void handleSetStatus(project, "active")} disabled={busy}>
                      Активувати
                    </button>
                  ) : null}
                  {project.status !== "on_hold" ? (
                    <button type="button" className="ghost" onClick={() => void handleSetStatus(project, "on_hold")} disabled={busy}>
                      Пауза
                    </button>
                  ) : null}
                  {project.status !== "archived" ? (
                    <button type="button" className="danger" onClick={() => void handleSetStatus(project, "archived")} disabled={busy}>
                      В архів
                    </button>
                  ) : (
                    <button type="button" className="ghost" onClick={() => void handleSetStatus(project, "active")} disabled={busy}>
                      Відновити
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );

  return (
    <section className="panel">
      <h2>Проєкти</h2>
      <p>Керуйте робочими проєктами та призначайте їх задачам, нотаткам і контекстним записам.</p>

      {!sessionToken ? <p className="empty-note">Відкрий Інбокс для авторизації сесії.</p> : null}
      {error ? <p className="error-note">{error}</p> : null}

      <div className="toolbar-row">
        <input
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          placeholder="Назва нового проєкту"
          disabled={!sessionToken || loading || workingProjectId === "create"}
        />
        <button
          type="button"
          onClick={() => void handleCreateProject()}
          disabled={!sessionToken || !newName.trim() || loading || workingProjectId === "create"}
        >
          Додати проєкт
        </button>
      </div>

      {loading ? <p>Завантаження проєктів...</p> : null}

      {!loading && items.length === 0 ? (
        <p className="empty-note">Поки що немає жодного проєкту. Створи перший, щоб організовувати задачі, нотатки й контекстні записи.</p>
      ) : (
        <>
          {renderList("Активні", active)}
          {renderList("На паузі", onHold)}
          {renderList("Архів", archived)}
        </>
      )}
    </section>
  );
}
