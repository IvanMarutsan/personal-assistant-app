import { useState } from "react";
import { useDiagnostics } from "../lib/diagnostics";

export function DiagnosticsPanel() {
  const diagnostics = useDiagnostics();
  const [copied, setCopied] = useState<"none" | "diag" | "issue">("none");
  const [copyError, setCopyError] = useState<string | null>(null);

  if (!diagnostics.debugEnabled) return null;

  async function runCopy(kind: "diag" | "issue") {
    setCopyError(null);
    const ok =
      kind === "diag" ? await diagnostics.copyDiagnostics() : await diagnostics.copyIssueTemplate();
    if (!ok) {
      setCopyError("Не вдалося скопіювати. Спробуй ще раз.");
      return;
    }
    setCopied(kind);
    setTimeout(() => setCopied("none"), 1500);
  }

  return (
    <details className="diagnostics-panel">
      <summary>Діагностика тестування</summary>
      <div className="diagnostics-grid">
        <p className="inbox-meta">Маршрут: {diagnostics.currentRoute}</p>
        <p className="inbox-meta">Середовище: {diagnostics.environmentLabel}</p>
        <p className="inbox-meta">Збірка: {diagnostics.buildMarker}</p>
        <p className="inbox-meta">Сесія: {diagnostics.sessionState}</p>
        <p className="inbox-meta">Часовий пояс: {diagnostics.timezone}</p>
        <p className="inbox-meta">
          Останнє оновлення: {diagnostics.lastRefreshAt ? new Date(diagnostics.lastRefreshAt).toLocaleString() : "—"}
        </p>
        <p className="inbox-meta">Джерело даних: {diagnostics.screenDataSource ?? "—"}</p>
        <p className="inbox-meta">
          Остання дія: {diagnostics.lastAction ? `${diagnostics.lastAction.name}` : "—"}
        </p>
        {diagnostics.lastAction?.context ? (
          <p className="inbox-meta">Контекст дії: {JSON.stringify(diagnostics.lastAction.context)}</p>
        ) : null}
        {diagnostics.lastFailure ? (
          <div className="diagnostics-error-box">
            <p className="inbox-meta">
              Останній невдалий запит: {diagnostics.lastFailure.path} · {diagnostics.lastFailure.status}
            </p>
            <p className="inbox-meta">Код: {diagnostics.lastFailure.code ?? "—"}</p>
            <p className="inbox-meta">Повідомлення: {diagnostics.lastFailure.message}</p>
          </div>
        ) : (
          <p className="inbox-meta">Невдалих запитів не було</p>
        )}
      </div>
      <div className="inbox-actions">
        <button type="button" onClick={() => void runCopy("diag")}>
          Скопіювати діагностику
        </button>
        <button type="button" className="ghost" onClick={() => void runCopy("issue")}>
          Повідомити про проблему
        </button>
      </div>
      {copied === "diag" ? <p className="inbox-meta">Діагностику скопійовано.</p> : null}
      {copied === "issue" ? <p className="inbox-meta">Шаблон проблеми скопійовано.</p> : null}
      {copyError ? <p className="error-note">{copyError}</p> : null}
    </details>
  );
}
