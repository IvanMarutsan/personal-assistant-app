import { useEffect, useMemo, useState } from "react";
import { NoteDetailModal } from "../../components/NoteDetailModal";
import { useDiagnostics } from "../../lib/diagnostics";
import { ApiError, createNote, deleteNote, getNotes, getProjects, updateNote } from "../../lib/api";
import type { NoteItem, ProjectItem } from "../../types/api";

const SESSION_KEY = "personal_assistant_app_session_token";

type NoteModalMode = "edit" | "create";

function noteTitle(note: NoteItem): string {
  const title = note.title?.trim();
  if (title) return title;
  const firstLine = note.body.split("\n")[0]?.trim();
  return firstLine && firstLine.length > 0 ? firstLine.slice(0, 80) : "Нотатка";
}

function projectName(note: NoteItem): string {
  if (!note.projects) return "Без проєкту";
  if (Array.isArray(note.projects)) return note.projects[0]?.name ?? "Без проєкту";
  return note.projects.name ?? "Без проєкту";
}

function previewBody(note: NoteItem): string {
  const text = note.body.replace(/\s+/g, " ").trim();
  return text.length > 160 ? `${text.slice(0, 160)}...` : text;
}

export function NotesPage() {
  const [items, setItems] = useState<NoteItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingNote, setPendingNote] = useState<NoteItem | null>(null);
  const [noteModalMode, setNoteModalMode] = useState<NoteModalMode>("edit");
  const [saving, setSaving] = useState(false);
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const diagnostics = useDiagnostics();
  const sessionToken = localStorage.getItem(SESSION_KEY) ?? "";

  async function loadNotes() {
    if (!sessionToken) {
      setItems([]);
      return;
    }

    setLoading(true);
    setError(null);
    diagnostics.trackAction("load_notes", { route: "/notes" });

    try {
      const notes = await getNotes(sessionToken);
      setItems(notes);
      diagnostics.markRefresh();
      diagnostics.setScreenDataSource("notes_data");
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
      setError(loadError instanceof Error ? loadError.message : "Не вдалося завантажити нотатки");
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
      setProjects(projectItems);
    } catch {
      setProjects([]);
    }
  }

  useEffect(() => {
    void Promise.all([loadNotes(), loadProjects()]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hasItems = useMemo(() => items.length > 0, [items]);

  async function deleteCurrentNote() {
    if (!sessionToken || !pendingNote || noteModalMode === "create") return;

    const confirmed = window.confirm(`Видалити нотатку "${noteTitle(pendingNote)}"?`);
    if (!confirmed) return;

    setSaving(true);
    setError(null);
    diagnostics.trackAction("delete_note", { noteId: pendingNote.id });
    try {
      await deleteNote({ sessionToken, noteId: pendingNote.id });
      await loadNotes();
      setPendingNote(null);
      setNoteModalMode("edit");
    } catch (deleteError) {
      if (deleteError instanceof ApiError) {
        diagnostics.trackFailure({
          path: deleteError.path,
          status: deleteError.status,
          code: deleteError.code,
          message: deleteError.message,
          details: deleteError.details
        });
      }
      setError(deleteError instanceof Error ? deleteError.message : "Не вдалося видалити нотатку");
    } finally {
      setSaving(false);
    }
  }

  async function saveNote(payload: { noteId?: string; title: string; body: string; convertToTask: boolean; projectId: string | null }) {
    if (!sessionToken) return;
    const isCreate = noteModalMode === "create";
    if (!isCreate && !pendingNote) return;

    setSaving(true);
    setError(null);
    diagnostics.trackAction(isCreate ? "create_note_manual" : "save_note", {
      noteId: pendingNote?.id ?? null,
      convertToTask: payload.convertToTask
    });
    try {
      if (isCreate) {
        await createNote({
          sessionToken,
          title: payload.title || null,
          body: payload.body,
          projectId: payload.projectId
        });
      } else {
        await updateNote({
          sessionToken,
          noteId: payload.noteId ?? pendingNote!.id,
          title: payload.title || null,
          body: payload.body,
          convertToTask: payload.convertToTask,
          projectId: payload.projectId
        });
      }
      await loadNotes();
      setPendingNote(null);
      setNoteModalMode("edit");
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
      setError(saveError instanceof Error ? saveError.message : isCreate ? "Не вдалося створити нотатку" : "Не вдалося зберегти нотатку");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel">
      <h2>Нотатки</h2>
      <p>Збережені нотатки з інбоксу, голосового розбору та ручного створення.</p>

      <div className="toolbar-row">
        <button
          type="button"
          onClick={() => {
            setPendingNote(null);
            setNoteModalMode("create");
            setError(null);
          }}
          disabled={!sessionToken || loading || saving}
        >
          Створити нотатку
        </button>
      </div>

      {!sessionToken ? <p className="empty-note">Відкрий Інбокс для авторизації сесії.</p> : null}
      {error ? <p className="error-note">{error}</p> : null}
      {loading ? <p>Завантаження нотаток...</p> : null}

      {!loading && !hasItems ? <p className="empty-note">Нотаток поки немає.</p> : null}

      {hasItems ? (
        <ul className="inbox-list">
          {items.map((note) => (
            <li key={note.id} className="inbox-item">
              <p className="inbox-main-text">{noteTitle(note)}</p>
              <p className="inbox-meta">
                {projectName(note)} · створено: {new Date(note.created_at).toLocaleString()}
              </p>
              <p className="inbox-meta">{previewBody(note)}</p>
              <div className="inbox-actions">
                <button
                  type="button"
                  onClick={() => {
                    setPendingNote(note);
                    setNoteModalMode("edit");
                  }}
                >
                  Відкрити
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      <NoteDetailModal
        open={noteModalMode === "create" || !!pendingNote}
        mode={noteModalMode}
        note={pendingNote}
        projects={projects}
        busy={saving}
        onClose={() => {
          setPendingNote(null);
          setNoteModalMode("edit");
        }}
        onDelete={() => {
          void deleteCurrentNote();
        }}
        onSave={(payload) => {
          void saveNote(payload);
        }}
      />
    </section>
  );
}
