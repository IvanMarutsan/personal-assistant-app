import { useEffect, useMemo, useState } from "react";
import { useDiagnostics } from "../../lib/diagnostics";
import { ApiError, getAiAdvisor, getPlanningAssistant, getTasks } from "../../lib/api";
import type { AiAdvisorSummary, PlanningSummary, TaskItem, TaskType } from "../../types/api";

const SESSION_KEY = "personal_assistant_app_session_token";

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatLocalDateTime(value: Date): string {
  return new Intl.DateTimeFormat("uk-UA", {
    dateStyle: "short",
    timeStyle: "short"
  }).format(value);
}

function projectName(task: TaskItem): string {
  if (!task.projects) return "Без проєкту";
  if (Array.isArray(task.projects)) return task.projects[0]?.name ?? "Без проєкту";
  return task.projects.name ?? "Без проєкту";
}

function taskTypeLabel(value: TaskType): string {
  switch (value) {
    case "deep_work":
      return "Глибока робота";
    case "quick_communication":
      return "Швидка комунікація";
    case "admin_operational":
      return "Адміністративне";
    case "recurring_essential":
      return "Регулярне важливе";
    case "personal_essential":
      return "Особисто важливе";
    case "someday":
      return "Колись";
  }
}

function reasonLabel(reason: string): string {
  const map: Record<string, string> = {
    reprioritized: "Репріоритизація",
    urgent_interrupt: "Термінове переривання",
    low_energy: "Низька енергія",
    waiting_response: "Очікування відповіді",
    waiting_on_external: "Очікування зовнішнього",
    underestimated: "Недооцінка обсягу",
    blocked_dependency: "Блокер/залежність",
    calendar_conflict: "Конфлікт у календарі",
    personal_issue: "Особисті обставини",
    other: "Інше"
  };
  return map[reason] ?? reason;
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

function timingLine(task: TaskItem): string {
  const scheduled = parseDate(task.scheduled_for);
  const due = parseDate(task.due_at);
  if (!scheduled && !due) return "Без часу";
  if (scheduled && due) return `Заплановано: ${formatLocalDateTime(scheduled)} · Дедлайн: ${formatLocalDateTime(due)}`;
  if (scheduled) return `Заплановано: ${formatLocalDateTime(scheduled)}`;
  return `Дедлайн: ${due ? formatLocalDateTime(due) : ""}`;
}

export function TodayPage() {
  const [items, setItems] = useState<TaskItem[]>([]);
  const [planning, setPlanning] = useState<PlanningSummary | null>(null);
  const [aiAdvisor, setAiAdvisor] = useState<AiAdvisorSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const diagnostics = useDiagnostics();

  const sessionToken = localStorage.getItem(SESSION_KEY) ?? "";

  async function loadToday() {
    if (!sessionToken) {
      setItems([]);
      setPlanning(null);
      setAiAdvisor(null);
      return;
    }

    setLoading(true);
    setError(null);
    diagnostics.trackAction("load_today", { route: "/today" });
    const errors: string[] = [];

    const [tasksResult, planningResult, aiResult] = await Promise.allSettled([
      getTasks(sessionToken),
      getPlanningAssistant(sessionToken),
      getAiAdvisor(sessionToken)
    ]);

    if (tasksResult.status === "fulfilled") {
      setItems(tasksResult.value);
    } else {
      const loadError = tasksResult.reason;
      if (loadError instanceof ApiError) {
        diagnostics.trackFailure({
          path: loadError.path,
          status: loadError.status,
          code: loadError.code,
          message: loadError.message,
          details: loadError.details
        });
      }
      errors.push("Не вдалося завантажити задачі для «Сьогодні». Спробуй оновити.");
    }

    if (planningResult.status === "fulfilled") {
      setPlanning(planningResult.value);
    } else {
      const loadError = planningResult.reason;
      if (loadError instanceof ApiError) {
        diagnostics.trackFailure({
          path: loadError.path,
          status: loadError.status,
          code: loadError.code,
          message: loadError.message,
          details: loadError.details
        });
      }
      errors.push("Не вдалося завантажити блок детермінованого планування.");
      setPlanning(null);
    }

    if (aiResult.status === "fulfilled") {
      setAiAdvisor(aiResult.value);
      diagnostics.setScreenDataSource(
        aiResult.value.source === "ai" ? "today:deterministic+ai" : "today:deterministic+ai_fallback"
      );
    } else {
      const loadError = aiResult.reason;
      if (loadError instanceof ApiError) {
        diagnostics.trackFailure({
          path: loadError.path,
          status: loadError.status,
          code: loadError.code,
          message: loadError.message,
          details: loadError.details
        });
      }
      setAiAdvisor(null);
    }

    if (errors.length > 0) {
      setError(errors.join(" "));
    }

    diagnostics.markRefresh();
    setLoading(false);
  }

  useEffect(() => {
    void loadToday();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        (task.status === "planned" || task.status === "in_progress" || task.status === "blocked") &&
        (task.is_protected_essential ||
          task.task_type === "recurring_essential" ||
          task.task_type === "personal_essential")
    );
  }, [items]);

  function renderSection(title: string, list: TaskItem[]) {
    return (
      <section className="today-section">
        <h3>{title}</h3>
        {list.length === 0 ? (
          <p className="empty-note">Порожньо.</p>
        ) : (
          <ul className="inbox-list">
            {list.map((task) => (
              <li className="inbox-item" key={task.id}>
                <p className="inbox-main-text">
                  {task.title}
                  {task.is_protected_essential ? (
                    <span className="essential-badge">Захищене важливе</span>
                  ) : null}
                </p>
                <p className="inbox-meta">
                  {projectName(task)} · {taskTypeLabel(task.task_type)} · {task.status === "blocked" ? "Заблоковано" : "Заплановано"}
                </p>
                <p className="inbox-meta">{timingLine(task)}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  }

  return (
    <section className="panel">
      <h2>Сьогодні</h2>
      <p>Зріз дня: рекомендації, перевантаження, ризики й підсумок.</p>

      {!sessionToken ? <p className="empty-note">Відкрий Інбокс для авторизації сесії.</p> : null}
      {error ? (
        <p className="error-note">
          {error}{" "}
          <button type="button" className="ghost inline-retry-btn" onClick={() => void loadToday()}>
            Оновити
          </button>
        </p>
      ) : null}
      {loading ? <p>Завантаження...</p> : null}

      {planning ? (
        <section className="assistant-block deterministic-block">
          <h3>План дня</h3>
          {diagnostics.debugEnabled ? (
            <p className="inbox-meta">
              Правила: {planning.rulesVersion} · Таймзона: {planning.timezone}
            </p>
          ) : null}

          <h3>Що робити зараз?</h3>
          {planning.whatNow.primary ? (
            <div className="assistant-primary">
              <p className="assistant-title">Пріоритет: {planning.whatNow.primary.title}</p>
              <p className="inbox-meta">{planning.whatNow.primary.reason}</p>
            </div>
          ) : (
            <p className="empty-note">Немає чіткої головної рекомендації.</p>
          )}

          {planning.whatNow.secondary.length > 0 ? (
            <ul className="assistant-secondary">
              {planning.whatNow.secondary.map((item, index) => (
                <li key={`${item.title}-${index}`}>
                  <strong>{item.title}</strong>
                  <span> — {item.reason}</span>
                </li>
              ))}
            </ul>
          ) : null}

          <h3>Сигнали перевантаження</h3>
          <p className="inbox-meta">
            Відкритих швидких комунікацій: {planning.overload.quickCommunicationOpenCount}
            {planning.overload.quickCommunicationBatchingRecommended ? " · рекомендується батчинг" : ""}
          </p>
          {planning.overload.flags.length === 0 ? (
            <p className="empty-note">Сигналів перевантаження зараз немає.</p>
          ) : (
            <ul className="assistant-secondary">
              {planning.overload.flags.map((flag) => (
                <li key={flag.code}>{flag.message}</li>
              ))}
            </ul>
          )}

          <h3>Щоденний підсумок</h3>
          <p className="inbox-meta">
            Виконано: {planning.dailyReview.completedTodayCount} · Перенесено: {planning.dailyReview.movedTodayCount} ·
            Скасовано: {planning.dailyReview.cancelledTodayCount} · Пропущено захищених: {" "}
            {planning.dailyReview.protectedEssentialsMissedToday}
          </p>
          {planning.dailyReview.topMovedReasons.length > 0 ? (
            <ul className="assistant-secondary">
              {planning.dailyReview.topMovedReasons.map((reason) => (
                <li key={reason.reason}>
                  {reasonLabel(reason.reason)}: {reason.count}
                </li>
              ))}
            </ul>
          ) : null}

          <h3>Ризики по essential</h3>
          <ul className="assistant-secondary">
            {planning.essentialRisk.protectedEssentialRisk.slice(0, 3).map((risk) => (
              <li key={`p-${risk.taskId}`}>
                {risk.title} ({risk.reason})
              </li>
            ))}
            {planning.essentialRisk.recurringEssentialRisk.slice(0, 3).map((risk) => (
              <li key={`r-${risk.taskId}`}>
                {risk.title} ({risk.reason})
              </li>
            ))}
            {planning.essentialRisk.squeezedOutRisk.slice(0, 3).map((risk) => (
              <li key={`s-${risk.taskId}`}>
                {risk.title} ({risk.reason})
              </li>
            ))}
            {planning.essentialRisk.protectedEssentialRisk.length === 0 &&
            planning.essentialRisk.recurringEssentialRisk.length === 0 &&
            planning.essentialRisk.squeezedOutRisk.length === 0 ? (
              <li>Критичних ризиків не виявлено.</li>
            ) : null}
          </ul>
        </section>
      ) : null}

      {aiAdvisor ? (
        <section className="assistant-block ai-block">
          <h3>Порада AI</h3>
          {diagnostics.debugEnabled ? (
            <p className="inbox-meta">
              Джерело: {aiAdvisor.source === "ai" ? `OpenAI (${aiAdvisor.model ?? "невідома модель"})` : "Fallback-правила"} ·
              Згенеровано: {new Date(aiAdvisor.generatedAt).toLocaleTimeString()}
            </p>
          ) : null}
          {aiAdvisor.fallbackReason && diagnostics.debugEnabled ? (
            <p className="empty-note">AI fallback увімкнений: {aiAdvisor.fallbackReason}</p>
          ) : null}

          <p className="assistant-title">{aiAdvisor.advisor.whatMattersMostNow}</p>

          <div className="assistant-primary">
            <p className="assistant-title">Рекомендована наступна дія: {aiAdvisor.advisor.suggestedNextAction.title}</p>
            <p className="inbox-meta">{aiAdvisor.advisor.suggestedNextAction.reason}</p>
          </div>

          <div className="assistant-primary">
            <p className="assistant-title">Що варто відкласти: {aiAdvisor.advisor.suggestedDefer.title}</p>
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
          {renderSection("Заплановано на сьогодні", plannedToday)}
          {renderSection("Прострочені заплановані", overduePlanned)}
          {renderSection("Захищені / регулярні essentials", protectedEssentials)}
        </>
      ) : null}
    </section>
  );
}
