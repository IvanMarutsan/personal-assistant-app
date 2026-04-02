import { Link, Route, Routes } from "react-router-dom";
import { InboxPage } from "./features/inbox/InboxPage";
import { TasksPage } from "./features/tasks/TasksPage";
import { TodayPage } from "./features/today/TodayPage";

export function App() {
  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>Personal Assistant</h1>
        <p>Unified inbox and adaptive planning workspace.</p>
      </header>

      <nav className="app-nav">
        <Link to="/">Inbox</Link>
        <Link to="/today">Today</Link>
        <Link to="/tasks">Tasks</Link>
      </nav>

      <main className="app-content">
        <Routes>
          <Route path="/" element={<InboxPage />} />
          <Route path="/today" element={<TodayPage />} />
          <Route path="/tasks" element={<TasksPage />} />
        </Routes>
      </main>
    </div>
  );
}
