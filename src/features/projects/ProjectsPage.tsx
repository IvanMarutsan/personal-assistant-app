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

export function ProjectsPage() {
  const [items, setItems] = useState<ProjectItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [workingProjectId, setWorkingProjectId] = useState<string | null>(null);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
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

  function beginRename(project: ProjectItem) {
    setEditingProjectId(project.id);
    setEditingName(project.name);
  }

  async function handleRename(project: ProjectItem, nextNameRaw: string) {
    if (!sessionToken) return;
    const nextName = nextNameRaw.trim();
    if (!nextName || nextName === project.name) {
      setEditingProjectId(null);
      setEditingName("");
      return;
    }

    setWorkingProjectId(project.id);
    setError(null);
    diagnostics.trackAction("rename_project", { route: "/projects", projectId: project.id });
    try {
      await updateProject({
        sessionToken,
        projectId: project.id,
        name: nextName
      });
      setEditingProjectId(null);
      setEditingName("");
      await loadProjects();
    } catch (renameError) {
      if (renameError instanceof ApiError) {
        diagnostics.trackFailure({
          path: renameError.path,
          status: renameError.status,
          code: renameError.code,
          message: renameError.message,
          details: renameError.details
        });
      }
      setError(renameError instanceof Error ? renameError.message : "Не вдалося перейменувати проєкт.");
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
                  <label>
                    Нова назва
                    <input
                      value={editingName}
                      onChange={(event) => setEditingName(event.target.value)}
                      disabled={busy}
                    />
                  </label>
                ) : (
                  <p className="inbox-main-text">{project.name}</p>
                )}
                <p className="inbox-meta">Статус: {statusLabel(project.status)} · Ранг: {project.rank}</p>
                <div className="inbox-actions">
                  {isEditing ? (
                    <>
                      <button
                        type="button"
                        onClick={() => void handleRename(project, editingName)}
                        disabled={busy || !editingName.trim()}
                      >
                        Зберегти назву
                      </button>
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => {
                          setEditingProjectId(null);
                          setEditingName("");
                        }}
                        disabled={busy}
                      >
                        Скасувати
                      </button>
                    </>
                  ) : (
                    <button type="button" className="ghost" onClick={() => beginRename(project)} disabled={busy}>
                      Перейменувати
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
      <p>Керуйте робочими проєктами та призначайте їх задачам/нотаткам.</p>

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
        <p className="empty-note">Поки що немає жодного проєкту. Створи перший, щоб організовувати задачі й нотатки.</p>
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
