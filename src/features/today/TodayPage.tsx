import { useEffect, useMemo, useState } from "react";
import { useDiagnostics } from "../../lib/diagnostics";
import {
  countMissingEstimates,
  formatTaskDateTime,
  formatTaskEstimate,
  formatTaskTimingSummary,
  isBacklogTask,
  isDueOnDay,
  isScheduledForDay,
  sortTasksByTimeField,
  sumKnownEstimateMinutes
} from "../../lib/taskTiming";
import {
  ApiError,
  getAiAdvisor,
  getGoogleCalendarStatus,
  getGoogleCalendarUpcoming,
  getPlanningAssistant,
  getTasks
} from "../../lib/api";
import type {
  AiAdvisorSummary,
  GoogleCalendarEventItem,
  GoogleCalendarStatus,
  PlanningSummary,
  TaskItem,
  TaskType
} from "../../types/api";

const SESSION_KEY = "personal_assistant_app_session_token";

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

function fallbackReasonLabel(reason: string | null): string {
  if (!reason) return "Резервний режим активовано без додаткової причини.";
  if (reason === "openai_not_configured") return "OpenAI не налаштовано.";
  if (reason === "invalid_ai_response") return "AI повернув невалідну відповідь.";
  if (reason === "ai_request_failed") return "Не вдалося отримати відповідь від AI.";
  return reason;
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

function formatKnownLoad(minutes: number): string {
  if (minutes <= 0) return "Немає відомого навантаження";
  const formatted = formatTaskEstimate(minutes);
  return formatted ? formatted : "Немає відомого навантаження";
}

function loadCoverageLine(input: { knownMinutes: number; missingCount: number; plannedCount: number }): string {
  if (input.plannedCount === 0) return "На сьогодні ще немає задач у денному плані.";
  if (input.knownMinutes <= 0 && input.missingCount > 0) {
    return `Оцінок для запланованого дня ще немає. Без оцінки лишаються ${input.missingCount} задач.`;
  }
  if (input.missingCount > 0) {
    return `Відоме навантаження: ${formatKnownLoad(input.knownMinutes)}. Без оцінки лишаються ${input.missingCount} задач.`;
  }
  return `Відоме навантаження запланованого дня: ${formatKnownLoad(input.knownMinutes)}.`;
}

export function TodayPage() {
  const [items, setItems] = useState<TaskItem[]>([]);
  const [planning, setPlanning] = useState<PlanningSummary | null>(null);
  const [aiAdvisor, setAiAdvisor] = useState<AiAdvisorSummary | null>(null);
  const [calendarStatus, setCalendarStatus] = useState<GoogleCalendarStatus | null>(null);
  const [calendarUpcoming, setCalendarUpcoming] = useState<GoogleCalendarEventItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const diagnostics = useDiagnostics();

  const sessionToken = localStorage.getItem(SESSION_KEY) ?? "";

  async function loadToday() {
    if (!sessionToken) {
      setItems([]);
      setPlanning(null);
      setAiAdvisor(null);
      setCalendarStatus(null);
      setCalendarUpcoming([]);
      return;
    }

    setLoading(true);
    setError(null);
    diagnostics.trackAction("load_today", { route: "/today" });
    const errors: string[] = [];

    const [tasksResult, planningResult, aiResult, calendarStatusResult, calendarUpcomingResult] = await Promise.allSettled([
      getTasks(sessionToken),
      getPlanningAssistant(sessionToken),
      getAiAdvisor(sessionToken),
      getGoogleCalendarStatus(sessionToken),
      getGoogleCalendarUpcoming(sessionToken)
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

    if (calendarStatusResult.status === "fulfilled") {
      setCalendarStatus(calendarStatusResult.value);
    } else {
      setCalendarStatus(null);
    }

    if (calendarUpcomingResult.status === "fulfilled") {
      setCalendarUpcoming(calendarUpcomingResult.value);
    } else {
      setCalendarUpcoming([]);
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

  const scheduledToday = useMemo(() => {
    const relevant = items.filter((task) => {
      if (task.status === "done" || task.status === "cancelled") return false;
      return isScheduledForDay(task, todayStart, todayEnd);
    });
    return sortTasksByTimeField(relevant, "scheduled_for");
  }, [items, todayEnd, todayStart]);

  const overdueScheduled = useMemo(() => {
    const relevant = items.filter((task) => {
      if (task.status === "done" || task.status === "cancelled") return false;
      if (!task.scheduled_for) return false;
      return new Date(task.scheduled_for).getTime() < todayStart.getTime();
    });
    return sortTasksByTimeField(relevant, "scheduled_for");
  }, [items, todayStart]);

  const dueTodayWithoutSchedule = useMemo(() => {
    const relevant = items.filter((task) => {
      if (task.status === "done" || task.status === "cancelled") return false;
      if (!isBacklogTask(task)) return false;
      return isDueOnDay(task, todayStart, todayEnd);
    });
    return sortTasksByTimeField(relevant, "due_at");
  }, [items, todayEnd, todayStart]);

  const backlogItems = useMemo(
    () =>
      items.filter(
        (task) => task.status !== "done" && task.status !== "cancelled" && isBacklogTask(task)
      ),
    [items]
  );

  const todayKnownEstimateMinutes = useMemo(() => sumKnownEstimateMinutes(scheduledToday), [scheduledToday]);
  const todayMissingEstimateCount = useMemo(() => countMissingEstimates(scheduledToday), [scheduledToday]);

  const protectedEssentials = useMemo(() => {
    return items.filter(
      (task) =>
        (task.status === "planned" || task.status === "in_progress" || task.status === "blocked") &&
        (task.is_protected_essential ||
          task.task_type === "recurring_essential" ||
          task.task_type === "personal_essential")
    );
  }, [items]);

  const calendarToday = useMemo(() => {
    return calendarUpcoming.filter((event) => {
      const raw = event.startAt;
      if (!raw) return false;
      const parsed = new Date(raw);
      if (Number.isNaN(parsed.getTime())) return false;
      return parsed >= todayStart && parsed <= todayEnd;
    });
  }, [calendarUpcoming, todayEnd, todayStart]);

  const nextCalendarEvent = useMemo(() => {
    const sorted = [...calendarUpcoming]
      .filter((event) => Boolean(event.startAt))
      .sort((a, b) => {
        const aTs = new Date(a.startAt ?? 0).getTime();
        const bTs = new Date(b.startAt ?? 0).getTime();
        return aTs - bTs;
      });
    return sorted.find((event) => {
      const ts = new Date(event.startAt ?? 0).getTime();
      return Number.isFinite(ts) && ts > todayEnd.getTime();
    });
  }, [calendarUpcoming, todayEnd]);

  function renderSection(title: string, description: string, list: TaskItem[]) {
    return (
      <section className="today-section">
        <h3>{title}</h3>
        <p className="inbox-meta">{description}</p>
        {list.length === 0 ? (
          <p className="empty-note">Порожньо.</p>
        ) : (
          <ul className="inbox-list">
            {list.map((task) => (
              <li className="inbox-item" key={task.id}>
                <p className="inbox-main-text">
                  {task.title}
                  {task.is_protected_essential ? <span className="essential-badge">Захищене важливе</span> : null}
                </p>
                <p className="inbox-meta">
                  {projectName(task)} · {taskTypeLabel(task.task_type)} · {task.status === "blocked" ? "Заблоковано" : task.status === "in_progress" ? "В роботі" : "Заплановано"}
                </p>
                <p className="inbox-meta">{formatTaskTimingSummary(task)}</p>
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
      <p>День будується навколо задач із планованим стартом на сьогодні, без автоматичного підтягування беклогу.</p>

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

          <p className="inbox-meta">
            У денному плані: {planning.overload.plannedTodayCount} · Дедлайни без плану: {planning.overload.dueTodayWithoutPlannedStartCount} · Беклог: {planning.overload.backlogCount}
          </p>
          <p className="inbox-meta">
            {loadCoverageLine({
              knownMinutes: planning.overload.scheduledKnownEstimateMinutes,
              missingCount: planning.overload.scheduledMissingEstimateCount,
              plannedCount: planning.overload.plannedTodayCount
            })}
          </p>

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
                  <span> - {item.reason}</span>
                </li>
              ))}
            </ul>
          ) : null}

          <h3>Сигнали плану</h3>
          <p className="inbox-meta">
            Прострочені заплановані: {planning.overload.overduePlannedCount} · Швидкі комунікації: {planning.overload.quickCommunicationOpenCount}
            {planning.overload.quickCommunicationBatchingRecommended ? " · варто закрити одним блоком" : ""}
          </p>
          {planning.overload.flags.length === 0 ? (
            <p className="empty-note">Сигнали перевантаження зараз не спрацювали.</p>
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
              Джерело: {aiAdvisor.source === "ai" ? `OpenAI (${aiAdvisor.model ?? "невідома модель"})` : "Резервні правила"} ·
              Згенеровано: {new Date(aiAdvisor.generatedAt).toLocaleTimeString()}
            </p>
          ) : null}
          {aiAdvisor.fallbackReason && diagnostics.debugEnabled ? (
            <p className="empty-note">Увімкнено резервний режим: {fallbackReasonLabel(aiAdvisor.fallbackReason)}</p>
          ) : null}

          <p className="assistant-title">{aiAdvisor.advisor.whatMattersMostNow}</p>
          <p className="inbox-meta">
            У плані: {aiAdvisor.contextSnapshot.plannedTodayCount} · Дедлайни без плану: {aiAdvisor.contextSnapshot.dueTodayWithoutPlannedStartCount} · Беклог: {aiAdvisor.contextSnapshot.backlogCount}
          </p>
          <p className="inbox-meta">
            {loadCoverageLine({
              knownMinutes: aiAdvisor.contextSnapshot.scheduledKnownEstimateMinutes,
              missingCount: aiAdvisor.contextSnapshot.scheduledMissingEstimateCount,
              plannedCount: aiAdvisor.contextSnapshot.plannedTodayCount
            })}
          </p>

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
          <section className="today-section">
            <h3>Календарний контекст</h3>
            {!calendarStatus?.connected ? (
              <p className="empty-note">Google Calendar не підключено. Підключи його на вкладці «Календар».</p>
            ) : (
              <>
                {calendarToday.length === 0 ? (
                  <p className="empty-note">На сьогодні подій не знайдено.</p>
                ) : (
                  <ul className="inbox-list">
                    {calendarToday.slice(0, 4).map((event) => (
                      <li className="inbox-item" key={event.id}>
                        <p className="inbox-main-text">{event.title}</p>
                        <p className="inbox-meta">{event.startAt ? formatTaskDateTime(new Date(event.startAt)) : "Без часу"}</p>
                      </li>
                    ))}
                  </ul>
                )}
                {nextCalendarEvent ? (
                  <p className="inbox-meta">
                    Наступна подія після сьогодні: {nextCalendarEvent.title} · {nextCalendarEvent.startAt ? formatTaskDateTime(new Date(nextCalendarEvent.startAt)) : "Без часу"}
                  </p>
                ) : null}
              </>
            )}
          </section>
          <section className="today-section">
            <h3>Структура дня</h3>
            <p className="inbox-meta">
              Заплановано на сьогодні: {scheduledToday.length} · Дедлайни сьогодні без плану: {dueTodayWithoutSchedule.length} · У беклозі: {backlogItems.length}
            </p>
            <p className="inbox-meta">{loadCoverageLine({ knownMinutes: todayKnownEstimateMinutes, missingCount: todayMissingEstimateCount, plannedCount: scheduledToday.length })}</p>
            <p className="inbox-meta">Сторінка «Сьогодні» зосереджена на задачах із планованим стартом. Беклог не підтягується в день автоматично.</p>
          </section>
          {renderSection("Заплановано на сьогодні", "Основний список дня: тільки задачі з планованим стартом на цей день.", scheduledToday)}
          {renderSection("Прострочені заплановані", "Задачі, у яких планований старт уже лишився в минулому.", overdueScheduled)}
          {renderSection("Дедлайни сьогодні без плану", "Окремо показані задачі з дедлайном на сьогодні, але без планованого старту.", dueTodayWithoutSchedule)}
          {renderSection("Захищені / регулярні важливі", "Огляд важливих регулярних і захищених задач без автопланування.", protectedEssentials)}
        </>
      ) : null}
    </section>
  );
}
