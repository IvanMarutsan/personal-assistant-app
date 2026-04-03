import { useEffect, useMemo, useState } from "react";
import { useDiagnostics } from "../../lib/diagnostics";
import { ApiError, getNotes } from "../../lib/api";
import type { NoteItem } from "../../types/api";

const SESSION_KEY = "personal_assistant_app_session_token";

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

  useEffect(() => {
    void loadNotes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hasItems = useMemo(() => items.length > 0, [items]);

  return (
    <section className="panel">
      <h2>Нотатки</h2>
      <p>Збережені нотатки з інбоксу та голосового triage.</p>

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
                {projectName(note)} · {new Date(note.created_at).toLocaleString()}
              </p>
              <p className="inbox-meta">{previewBody(note)}</p>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
