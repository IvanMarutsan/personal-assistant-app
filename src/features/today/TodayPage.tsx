import { useEffect, useMemo, useState } from "react";
import { useDiagnostics } from "../../lib/diagnostics";
import { ApiError, getAiAdvisor, getPlanningAssistant, getTasks } from "../../lib/api";
import type { AiAdvisorSummary, PlanningSummary, TaskItem } from "../../types/api";

const SESSION_KEY = "personal_assistant_app_session_token";

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function projectName(task: TaskItem): string {
  if (!task.projects) return "No project";
  if (Array.isArray(task.projects)) return task.projects[0]?.name ?? "No project";
  return task.projects.name ?? "No project";
}

function startOfToday(now: Date): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfToday(now: Date): Date {
  const d = new Date(now);
  d.setHours(23, 59, 59, 999);
  return d;
}

export function TodayPage() {
  const [items, setItems] = useState<TaskItem[]>([]);
  const [planning, setPlanning] = useState<PlanningSummary | null>(null);
  const [aiAdvisor, setAiAdvisor] = useState<AiAdvisorSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const diagnostics = useDiagnostics();

  const sessionToken = localStorage.getItem(SESSION_KEY) ?? "";

  useEffect(() => {
    const load = async () => {
      if (!sessionToken) {
        setItems([]);
        setPlanning(null);
        setAiAdvisor(null);
        return;
      }

      setLoading(true);
      setError(null);
      diagnostics.trackAction("load_today", { route: "/today" });

      try {
        const [tasks, planningSummary, aiSummary] = await Promise.all([
          getTasks(sessionToken),
          getPlanningAssistant(sessionToken),
          getAiAdvisor(sessionToken)
        ]);
        setItems(tasks);
        setPlanning(planningSummary);
        setAiAdvisor(aiSummary);
        diagnostics.markRefresh();
        diagnostics.setScreenDataSource(
          aiSummary.source === "ai" ? "today:deterministic+ai" : "today:deterministic+ai_fallback"
        );
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
        setError(loadError instanceof Error ? loadError.message : "Failed to load today view");
      } finally {
        setLoading(false);
      }
    };

    void load();
  }, [sessionToken]);

  const now = new Date();
  const todayStart = startOfToday(now);
  const todayEnd = endOfToday(now);

  const plannedToday = useMemo(() => {
    return items.filter((task) => {
      if (task.status !== "planned") return false;
      const candidate = parseDate(task.scheduled_for) ?? parseDate(task.due_at);
      return !!candidate && candidate >= todayStart && candidate <= todayEnd;
    });
  }, [items, todayEnd, todayStart]);

  const overduePlanned = useMemo(() => {
    return items.filter((task) => {
      if (task.status !== "planned") return false;
      const candidate = parseDate(task.due_at) ?? parseDate(task.scheduled_for);
      return !!candidate && candidate < todayStart;
    });
  }, [items, todayStart]);

  const protectedEssentials = useMemo(() => {
    return items.filter(
      (task) =>
        task.is_protected_essential ||
        task.task_type === "recurring_essential" ||
        task.task_type === "personal_essential"
    );
  }, [items]);

  function renderSection(title: string, list: TaskItem[]) {
    return (
      <section className="today-section">
        <h3>{title}</h3>
        {list.length === 0 ? (
          <p className="empty-note">None</p>
        ) : (
          <ul className="inbox-list">
            {list.map((task) => (
              <li className="inbox-item" key={task.id}>
                <p className="inbox-main-text">
                  {task.title}
                  {task.is_protected_essential ? (
                    <span className="essential-badge">Protected essential</span>
                  ) : null}
                </p>
                <p className="inbox-meta">
                  {projectName(task)} · {task.task_type} · {task.status}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  }

  return (
    <section className="panel">
      <h2>Today</h2>
      <p>Rules-based snapshot: recommendations, overload, risks, and daily review.</p>

      {!sessionToken ? <p className="empty-note">Open Inbox first to authenticate session.</p> : null}
      {error ? <p className="error-note">{error}</p> : null}
      {loading ? <p>Loading today view...</p> : null}

      {planning ? (
        <section className="assistant-block deterministic-block">
          <h3>Deterministic Assistant (rules baseline)</h3>
          <p className="inbox-meta">
            Rules: {planning.rulesVersion} · Timezone: {planning.timezone}
          </p>
          <h3>What should I do now?</h3>
          {planning.whatNow.primary ? (
            <div className="assistant-primary">
              <p className="assistant-title">Primary: {planning.whatNow.primary.title}</p>
              <p className="inbox-meta">{planning.whatNow.primary.reason}</p>
            </div>
          ) : (
            <p className="empty-note">No clear primary recommendation.</p>
          )}

          {planning.whatNow.secondary.length > 0 ? (
            <ul className="assistant-secondary">
              {planning.whatNow.secondary.map((item, index) => (
                <li key={`${item.title}-${index}`}>
                  <strong>{item.title}</strong>
                  <span> - {item.reason}</span>
                </li>
              ))}
            </ul>
          ) : null}

          <h3>Overload Signals</h3>
          <p className="inbox-meta">
            Quick communication open: {planning.overload.quickCommunicationOpenCount}
            {planning.overload.quickCommunicationBatchingRecommended ? " · batching recommended" : ""}
          </p>
          {planning.overload.flags.length === 0 ? (
            <p className="empty-note">No overload signals right now.</p>
          ) : (
            <ul className="assistant-secondary">
              {planning.overload.flags.map((flag) => (
                <li key={flag.code}>{flag.message}</li>
              ))}
            </ul>
          )}

          <h3>Daily Review</h3>
          <p className="inbox-meta">
            Completed: {planning.dailyReview.completedTodayCount} · Moved: {planning.dailyReview.movedTodayCount} ·
            Cancelled: {planning.dailyReview.cancelledTodayCount} · Protected missed: {" "}
            {planning.dailyReview.protectedEssentialsMissedToday}
          </p>
          {planning.dailyReview.topMovedReasons.length > 0 ? (
            <ul className="assistant-secondary">
              {planning.dailyReview.topMovedReasons.map((reason) => (
                <li key={reason.reason}>
                  {reason.reason}: {reason.count}
                </li>
              ))}
            </ul>
          ) : null}

          <h3>Essential Risk</h3>
          <ul className="assistant-secondary">
            {planning.essentialRisk.protectedEssentialRisk.slice(0, 3).map((risk) => (
              <li key={`p-${risk.taskId}`}>{risk.title} ({risk.reason})</li>
            ))}
            {planning.essentialRisk.recurringEssentialRisk.slice(0, 3).map((risk) => (
              <li key={`r-${risk.taskId}`}>{risk.title} ({risk.reason})</li>
            ))}
            {planning.essentialRisk.squeezedOutRisk.slice(0, 3).map((risk) => (
              <li key={`s-${risk.taskId}`}>{risk.title} ({risk.reason})</li>
            ))}
            {planning.essentialRisk.protectedEssentialRisk.length === 0 &&
            planning.essentialRisk.recurringEssentialRisk.length === 0 &&
            planning.essentialRisk.squeezedOutRisk.length === 0 ? (
              <li>No essential risk signals detected.</li>
            ) : null}
          </ul>
        </section>
      ) : null}

      {aiAdvisor ? (
        <section className="assistant-block ai-block">
          <h3>AI Advisor (read-only recommendations)</h3>
          <p className="inbox-meta">
            Source: {aiAdvisor.source === "ai" ? `OpenAI (${aiAdvisor.model ?? "unknown model"})` : "Fallback rules"} ·
            Generated: {new Date(aiAdvisor.generatedAt).toLocaleTimeString()}
          </p>
          {aiAdvisor.fallbackReason ? (
            <p className="empty-note">AI fallback active: {aiAdvisor.fallbackReason}</p>
          ) : null}

          <p className="assistant-title">{aiAdvisor.advisor.whatMattersMostNow}</p>

          <div className="assistant-primary">
            <p className="assistant-title">Suggested next action: {aiAdvisor.advisor.suggestedNextAction.title}</p>
            <p className="inbox-meta">{aiAdvisor.advisor.suggestedNextAction.reason}</p>
          </div>

          <div className="assistant-primary">
            <p className="assistant-title">Suggested defer: {aiAdvisor.advisor.suggestedDefer.title}</p>
            <p className="inbox-meta">{aiAdvisor.advisor.suggestedDefer.reason}</p>
          </div>

          <p className={aiAdvisor.advisor.protectedEssentialsWarning.hasWarning ? "error-note" : "inbox-meta"}>
            {aiAdvisor.advisor.protectedEssentialsWarning.message}
          </p>
          <p className="inbox-meta">{aiAdvisor.advisor.explanation}</p>
        </section>
      ) : null}

      {!loading ? (
        <>
          {renderSection("Planned Today", plannedToday)}
          {renderSection("Overdue Planned", overduePlanned)}
          {renderSection("Protected Essentials", protectedEssentials)}
        </>
      ) : null}
    </section>
  );
}
