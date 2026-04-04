import { Link, Route, Routes } from "react-router-dom";
import { DiagnosticsPanel } from "./components/DiagnosticsPanel";
import { InboxPage } from "./features/inbox/InboxPage";
import { NotesPage } from "./features/notes/NotesPage";
import { TasksPage } from "./features/tasks/TasksPage";
import { TodayPage } from "./features/today/TodayPage";
import { CalendarPage } from "./features/calendar/CalendarPage";
import { ProjectsPage } from "./features/projects/ProjectsPage";
import { useDiagnostics } from "./lib/diagnostics";

export function App() {
  const diagnostics = useDiagnostics();

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>Персональний Асистент</h1>
        <p>Єдиний інбокс і простір адаптивного планування.</p>
        {diagnostics.debugEnabled ? (
          <p className="debug-badge">
            режим відлагодження · {diagnostics.environmentLabel} · {diagnostics.buildMarker} · {diagnostics.currentRoute}
          </p>
        ) : null}
      </header>

      <nav className="app-nav">
        <Link to="/">Інбокс</Link>
        <Link to="/today">Сьогодні</Link>
        <Link to="/tasks">Задачі</Link>
        <Link to="/projects">Проєкти</Link>
        <Link to="/notes">Нотатки</Link>
        <Link to="/calendar">Календар</Link>
      </nav>

      <main className="app-content">
        <DiagnosticsPanel />
        <Routes>
          <Route path="/" element={<InboxPage />} />
          <Route path="/today" element={<TodayPage />} />
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/notes" element={<NotesPage />} />
          <Route path="/calendar" element={<CalendarPage />} />
        </Routes>
      </main>
    </div>
  );
}
