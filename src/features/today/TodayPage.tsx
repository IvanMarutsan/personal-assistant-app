import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CalendarEventModal } from "../../components/CalendarEventModal";
import { NoteDetailModal } from "../../components/NoteDetailModal";
import { PlanningConversationModal } from "../../components/PlanningConversationModal";
import { TaskDetailModal } from "../../components/TaskDetailModal";
import { useDiagnostics } from "../../lib/diagnostics";
import { taskTypeLabel } from "../../lib/taskTypes";
import {
  countMissingEstimates,
  formatTaskDateTime,
  formatTaskEstimate,
  formatTaskTimingSummary,
  isBacklogTask,
  isDueOnDay,
  isScheduledForDay,
  sortTasksByTimeField,
  planningFlexibilityLabel,
  sumKnownEstimateMinutes
} from "../../lib/taskTiming";
import {
  ApiError,
  applyTaskCalendarInbound,
  createNote,
  createTask,
  deleteCalendarBlock,
  detachTaskCalendarLink as detachTaskCalendarLinkRequest,
  getAiAdvisor,
  getCalendarBlocks,
  getGoogleCalendarStatus,
  inspectTaskCalendarInbound,
  keepTaskCalendarLocalVersion,
  getPlanningAssistant,
  getPlanningConversation,
  getProjects,
  getTasks,
  retryTaskCalendarSync as retryTaskCalendarSyncRequest,
  sendPlanningConversationTurn,
  transcribePlanningVoice,
  updatePlanningProposal,
  updateTask,
  upsertCalendarBlock
} from "../../lib/api";
import type {
  AiAdvisorSummary,
  CalendarBlockItem,
  GoogleCalendarStatus,
  PlanningConversationScopeType,
  PlanningConversationState,
  PlanningSummary,
  ProjectItem,
  TaskCalendarInboundState,
  TaskItem,
  TaskType
} from "../../types/api";

const SESSION_KEY = "personal_assistant_app_session_token";

function projectName(task: TaskItem): string {
  if (!task.projects) return "Без проєкту";
  if (Array.isArray(task.projects)) return task.projects[0]?.name ?? "Без проєкту";
  return task.projects.name ?? "Без проєкту";
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
  return "Резервний режим увімкнено.";
}

function normalizePlanningCopy(text: string): string {
  const exactMap: Record<string, string> = {
    "Overdue planned task should be pulled forward first.": "Прострочену заплановану задачу варто підтягнути першою.",
    "High-importance task is planned for today.": "На сьогодні вже є запланована задача з високою важливістю.",
    "Hard commitment is planned for today and should be protected.": "Жорстке зобов’язання на сьогодні потребує захисту.",
    "Due-today task is still unscheduled.": "Є задача з дедлайном на сьогодні без планованого старту.",
    "Protected essential task is still open.": "Захищена важлива задача ще не закрита.",
    "Backlog should not be treated as today's plan.": "Беклог не варто сприймати як частину сьогоднішнього плану."
  };

  if (!text) return text;

  let normalized = exactMap[text.trim()] ?? text;
  const replacements: Array<[string, string]> = [
    ["Overdue planned task", "Прострочена запланована задача"],
    ["should be pulled forward first", "варто підтягнути першою"],
    ["High-importance task", "Задача з високою важливістю"],
    ["planned for today", "запланована на сьогодні"],
    ["planned task", "запланована задача"],
    ["Hard commitment", "Жорстке зобов’язання"],
    ["due-today", "з дедлайном на сьогодні"],
    ["unscheduled", "без планованого старту"],
    ["backlog", "беклог"],
    ["Backlog", "Беклог"]
  ];

  for (const [from, to] of replacements) {
    normalized = normalized.replaceAll(from, to);
  }

  return normalized;
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

function startOfWeekLocal(value: Date): Date {
  const start = startOfToday(value);
  const weekday = start.getDay();
  const delta = weekday === 0 ? -6 : 1 - weekday;
  start.setDate(start.getDate() + delta);
  return start;
}

function toWeekScopeDate(value: Date): string {
  return toScopeDate(startOfWeekLocal(value));
}

function toScopeDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseScopeDateLocal(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(year || new Date().getFullYear(), (month || 1) - 1, day || 1, 0, 0, 0, 0);
  if (Number.isNaN(parsed.getTime())) {
    return startOfToday(new Date());
  }
  return parsed;
}

function shiftScopeDate(value: string, days: number): string {
  const parsed = parseScopeDateLocal(value);
  parsed.setDate(parsed.getDate() + days);
  return toScopeDate(parsed);
}

function formatScopeDateLabel(value: string): string {
  const parsed = new Date(`${value}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("uk-UA", { weekday: "long", day: "numeric", month: "long" }).format(parsed);
}

function defaultScheduledForForSelectedDay(input: { scopeDate: string; isSelectedToday: boolean }): string | null {
  if (input.isSelectedToday) return null;
  const selected = parseScopeDateLocal(input.scopeDate);
  selected.setHours(9, 0, 0, 0);
  return selected.toISOString();
}
function formatKnownLoad(minutes: number): string {
  if (minutes <= 0) return "Немає відомого навантаження";
  const formatted = formatTaskEstimate(minutes);
  return formatted ? formatted : "Немає відомого навантаження";
}

function loadCoverageLine(input: { knownMinutes: number; missingCount: number; plannedCount: number }): string {
  if (input.plannedCount === 0) return "\u041d\u0430 \u0446\u0435\u0439 \u0434\u0435\u043d\u044c \u0449\u0435 \u043d\u0435\u043c\u0430\u0454 \u0437\u0430\u0434\u0430\u0447 \u0443 \u0434\u0435\u043d\u043d\u043e\u043c\u0443 \u043f\u043b\u0430\u043d\u0456.";
  if (input.knownMinutes <= 0 && input.missingCount > 0) {
    return `Оцінок для запланованого дня ще немає. Без оцінки лишаються ${input.missingCount} задач.`;
  }
  if (input.missingCount > 0) {
    return `Відоме навантаження: ${formatKnownLoad(input.knownMinutes)}. Без оцінки лишаються ${input.missingCount} задач.`;
  }
  return `Відоме навантаження запланованого дня: ${formatKnownLoad(input.knownMinutes)}.`;
}

function formatWeekRangeLabel(scopeDate: string): string {
  const start = parseScopeDateLocal(scopeDate);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  return `${new Intl.DateTimeFormat("uk-UA", { day: "numeric", month: "long" }).format(start)} - ${new Intl.DateTimeFormat("uk-UA", { day: "numeric", month: "long" }).format(end)}`;
}

function weekLoadCoverageLine(input: { knownMinutes: number; missingCount: number; plannedCount: number }): string {
  if (input.plannedCount === 0) return "На цей тиждень ще немає задач із планованим стартом.";
  if (input.knownMinutes <= 0 && input.missingCount > 0) {
    return `Оцінок для тижневого плану ще немає. Без оцінки лишаються ${input.missingCount} задач.`;
  }
  if (input.missingCount > 0) {
    return `Відоме навантаження тижня: ${formatKnownLoad(input.knownMinutes)}. Без оцінки лишаються ${input.missingCount} задач.`;
  }
  return `Відоме навантаження тижня: ${formatKnownLoad(input.knownMinutes)}.`;
}

function weekDayPressureLabel(input: {
  plannedCount: number;
  dueWithoutPlannedStartCount: number;
  scheduledKnownEstimateMinutes: number;
  calendarBusyMinutes: number | null;
  scheduledMissingEstimateCount: number;
}): string {
  const loadScore = input.scheduledKnownEstimateMinutes + (input.calendarBusyMinutes ?? 0);
  if (input.dueWithoutPlannedStartCount > 0 || loadScore >= 480 || input.plannedCount >= 5) return "Напруженіше";
  if (input.plannedCount === 0 && input.dueWithoutPlannedStartCount === 0 && loadScore < 180) return "Легше";
  if (input.scheduledMissingEstimateCount > 0) return "Потрібне уточнення";
  return "Рівно";
}

function formatWeekDaySummary(day: PlanningSummary["weekDays"][number]): string {
  const dayLabel = formatScopeDateLabel(day.scopeDate);
  const parts = [
    `${dayLabel}: ${weekDayPressureLabel(day)}`,
    `план ${day.plannedCount}`,
    `дедлайни без плану ${day.dueWithoutPlannedStartCount}`
  ];
  if (day.scheduledKnownEstimateMinutes > 0) parts.push(`оцінено ${formatTaskEstimate(day.scheduledKnownEstimateMinutes)}`);
  if (day.calendarEventCount > 0) parts.push(`календар ${day.calendarEventCount}`);
  if (day.worklogCount > 0) parts.push(`контекст ${day.worklogCount}`);
  if (day.scheduledMissingEstimateCount > 0) parts.push(`без оцінки ${day.scheduledMissingEstimateCount}`);
  return parts.join(" · ");
}

function worklogSourceLabel(value: string): string {
  if (value === "manual") return "вручну";
  if (value === "voice_candidate") return "з голосу";
  if (value === "inbox" || value === "inbox_triage") return "з інбоксу";
  return "інше";
}

function formatWorklogSummary(input: { count: number; withoutProjectCount: number; topProjects: Array<{ name: string; count: number }> }): string {
  if (input.count === 0) return "Контекстних записів за цей день немає.";
  const topProjects = input.topProjects.slice(0, 2).map((item) => `${item.name}: ${item.count}`).join(" · ");
  const parts = [`Контекстні записи: ${input.count}`, `без проєкту: ${input.withoutProjectCount}`];
  if (topProjects) parts.push(`найчастіше: ${topProjects}`);
  return parts.join(" · ");
}

function formatWorklogSources(items: Array<{ source: string; count: number }>): string | null {
  if (items.length === 0) return null;
  return items
    .slice(0, 3)
    .map((item) => `${worklogSourceLabel(item.source)}: ${item.count}`)
    .join(" · ");
}
function weeklyReviewEmptyLabel(section: keyof NonNullable<PlanningSummary["weeklyReview"]>): string {
  switch (section) {
    case "done":
      return "\u042f\u0432\u043d\u043e \u0437\u0430\u043a\u0440\u0438\u0442\u0438\u0445 \u0437\u0430\u0434\u0430\u0447 \u0437\u0430 \u0446\u0435\u0439 \u0442\u0438\u0436\u0434\u0435\u043d\u044c \u043d\u0435 \u0432\u0438\u0434\u043d\u043e.";
    case "notDone":
      return "\u041d\u0435\u0437\u0430\u043a\u0440\u0438\u0442\u0438\u0445 \u0437\u0430\u0434\u0430\u0447 \u0456\u0437 \u043f\u043b\u0430\u043d\u0443 \u0442\u0438\u0436\u043d\u044f \u0437\u0430\u0440\u0430\u0437 \u043d\u0435 \u0432\u0438\u0434\u043d\u043e.";
    case "moved":
      return "\u041f\u043e\u043c\u0456\u0442\u043d\u0438\u0445 \u0437\u0441\u0443\u0432\u0456\u0432 \u0443 \u043c\u0435\u0436\u0430\u0445 \u0442\u0438\u0436\u043d\u044f \u043d\u0435 \u0432\u0438\u0434\u043d\u043e.";
    case "shouldMove":
      return "\u042f\u0432\u043d\u0438\u0445 \u043a\u0430\u043d\u0434\u0438\u0434\u0430\u0442\u0456\u0432 \u043d\u0430 \u0440\u0443\u0447\u043d\u0435 \u043f\u0435\u0440\u0435\u043d\u0435\u0441\u0435\u043d\u043d\u044f \u0437\u0430\u0440\u0430\u0437 \u043d\u0435\u043c\u0430\u0454.";
    case "shouldKill":
      return "\u0421\u043b\u0430\u0431\u043a\u0438\u0445 \u043a\u0430\u043d\u0434\u0438\u0434\u0430\u0442\u0456\u0432 \u043d\u0430 \u043f\u0440\u0438\u0431\u0438\u0440\u0430\u043d\u043d\u044f \u043f\u043e\u043a\u0438 \u043d\u0435 \u0432\u0438\u0434\u043d\u043e.";
  }
}

type WeekResolveAction = {
  key: string;
  title: string;
  reason: string;
  actionLabel: string;
  onClick: () => void;
};
function needsPlanningTouch(task: TaskItem): boolean {
  return !task.due_at || !task.estimated_minutes;
}
type CalendarNotice = {
  tone: "success" | "error" | "info";
  message: string;
};

function calendarLinkHint(task: TaskItem): string | null {
  if (task.calendar_sync_error) return "Google Calendar: \u043f\u043e\u0442\u0440\u0456\u0431\u043d\u0430 \u0443\u0432\u0430\u0433\u0430";
  if (task.calendar_sync_mode === "app_managed" && task.linked_calendar_event) return "Google Calendar: \u0441\u0438\u043d\u0445\u0440\u043e\u043d\u0456\u0437\u043e\u0432\u0430\u043d\u043e";
  if (task.calendar_sync_mode === "manual" && task.linked_calendar_event) return "Google Calendar: \u0440\u0443\u0447\u043d\u0438\u0439 \u0437\u0432\u2019\u044f\u0437\u043e\u043a";
  return null;
}

function shouldShowDayReviewPrompt(input: {
  isSelectedToday: boolean;
  openPlannedCount: number;
  dueWithoutScheduleCount: number;
  worklogCount: number;
}): boolean {
  if (!input.isSelectedToday) return false;
  return input.openPlannedCount > 0 || input.dueWithoutScheduleCount > 0 || input.worklogCount === 0;
}

function formatCalendarEventTimeRange(event: { start_at: string; end_at: string; is_all_day: boolean }): string {
  if (event.is_all_day) return "Увесь день";
  const start = new Date(event.start_at);
  if (Number.isNaN(start.getTime())) return "Без часу";
  const startLabel = formatTaskDateTime(start);
  const end = new Date(event.end_at);
  if (Number.isNaN(end.getTime())) return startLabel;
  return `${startLabel} - ${new Intl.DateTimeFormat("uk-UA", { hour: "2-digit", minute: "2-digit" }).format(end)}`;
}

function projectNameForCalendarBlock(block: CalendarBlockItem): string {
  if (!block.projects) return "Без проєкту";
  if (Array.isArray(block.projects)) return block.projects[0]?.name ?? "Без проєкту";
  return block.projects.name ?? "Без проєкту";
}

function shouldShowWeekReviewPrompt(input: {
  isCurrentWeek: boolean;
  hasWeeklyReview: boolean;
  weeklyWorklogCount: number;
  plannedCount: number;
  backlogCount: number;
}): boolean {
  if (!input.isCurrentWeek) return false;
  if (!input.hasWeeklyReview) return false;
  return input.plannedCount > 0 || input.backlogCount > 0 || input.weeklyWorklogCount === 0;
}
type TodayPageProps = {
  surface?: "day" | "week";
};

export function TodayPage({ surface = "day" }: TodayPageProps) {
  const [items, setItems] = useState<TaskItem[]>([]);
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [planning, setPlanning] = useState<PlanningSummary | null>(null);
  const [weekPlanning, setWeekPlanning] = useState<PlanningSummary | null>(null);
  const [aiAdvisor, setAiAdvisor] = useState<AiAdvisorSummary | null>(null);
  const [weekAiAdvisor, setWeekAiAdvisor] = useState<AiAdvisorSummary | null>(null);
  const [calendarStatus, setCalendarStatus] = useState<GoogleCalendarStatus | null>(null);
  const [dayCalendarBlocks, setDayCalendarBlocks] = useState<CalendarBlockItem[]>([]);
  const [weekCalendarBlocks, setWeekCalendarBlocks] = useState<CalendarBlockItem[]>([]);
  const [activeCalendarBlock, setActiveCalendarBlock] = useState<CalendarBlockItem | null>(null);
  const [calendarBlockCreateOpen, setCalendarBlockCreateOpen] = useState(false);
  const [calendarBlockBusy, setCalendarBlockBusy] = useState(false);
  const [calendarBlockError, setCalendarBlockError] = useState<string | null>(null);
  const [activeTask, setActiveTask] = useState<TaskItem | null>(null);
  const [taskModalMode, setTaskModalMode] = useState<"edit" | "create">("edit");
  const [noteCreateOpen, setNoteCreateOpen] = useState(false);
  const [noteCreating, setNoteCreating] = useState(false);
  const [planningConversationOpen, setPlanningConversationOpen] = useState(false);
  const [planningConversation, setPlanningConversation] = useState<PlanningConversationState | null>(null);
  const [planningConversationBusy, setPlanningConversationBusy] = useState(false);
  const [planningConversationError, setPlanningConversationError] = useState<string | null>(null);
  const [planningConversationScopeType, setPlanningConversationScopeType] = useState<PlanningConversationScopeType>("day");
  const [actingProposalId, setActingProposalId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [workingTaskId, setWorkingTaskId] = useState<string | null>(null);
  const [calendarNotice, setCalendarNotice] = useState<CalendarNotice | null>(null);
  const [calendarInboundState, setCalendarInboundState] = useState<TaskCalendarInboundState | null>(null);
  const diagnostics = useDiagnostics();
  const navigate = useNavigate();

  const sessionToken = localStorage.getItem(SESSION_KEY) ?? "";

  async function loadToday() {
    if (!sessionToken) {
      setItems([]);
      setProjects([]);
      setPlanning(null);
      setWeekPlanning(null);
      setAiAdvisor(null);
      setWeekAiAdvisor(null);
      setCalendarStatus(null);
      setDayCalendarBlocks([]);
      setWeekCalendarBlocks([]);
      return;
    }

    setLoading(true);
    setError(null);
    diagnostics.trackAction("load_today", { route: "/today" });
    const errors: string[] = [];
    const dayRangeStart = parseScopeDateLocal(selectedScopeDate);
    dayRangeStart.setHours(0, 0, 0, 0);
    const dayRangeEnd = endOfToday(dayRangeStart);
    const dayFetchMax = new Date(dayRangeEnd);
    dayFetchMax.setDate(dayFetchMax.getDate() + 7);
    dayFetchMax.setHours(23, 59, 59, 999);
    const weekRangeStart = parseScopeDateLocal(selectedWeekScopeDate);
    weekRangeStart.setHours(0, 0, 0, 0);
    const weekRangeEnd = new Date(weekRangeStart);
    weekRangeEnd.setDate(weekRangeEnd.getDate() + 6);
    weekRangeEnd.setHours(23, 59, 59, 999);

    const [tasksResult, projectsResult, planningResult, weekPlanningResult, aiResult, weekAiResult, calendarStatusResult, dayCalendarBlocksResult, weekCalendarBlocksResult] = await Promise.allSettled([
      getTasks(sessionToken),
      getProjects(sessionToken),
      getPlanningAssistant(sessionToken, selectedScopeDate, "day"),
      getPlanningAssistant(sessionToken, selectedWeekScopeDate, "week"),
      getAiAdvisor(sessionToken, selectedScopeDate, "day"),
      getAiAdvisor(sessionToken, selectedWeekScopeDate, "week"),
      getGoogleCalendarStatus(sessionToken),
      getCalendarBlocks({ sessionToken, timeMin: dayRangeStart.toISOString(), timeMax: dayFetchMax.toISOString(), maxResults: 120 }),
      getCalendarBlocks({ sessionToken, timeMin: weekRangeStart.toISOString(), timeMax: weekRangeEnd.toISOString(), maxResults: 160 })
    ]);

    if (tasksResult.status === "fulfilled") {
      setItems(tasksResult.value);
      setActiveTask((current) => {
        if (!current) return null;
        return tasksResult.value.find((task) => task.id === current.id) ?? null;
      });
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

    if (projectsResult.status === "fulfilled") {
      setProjects(projectsResult.value);
    } else {
      setProjects([]);
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

    if (weekPlanningResult.status === "fulfilled") {
      setWeekPlanning(weekPlanningResult.value);
    } else {
      setWeekPlanning(null);
      errors.push("Не вдалося завантажити тижневий план.");
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

    if (weekAiResult.status === "fulfilled") {
      setWeekAiAdvisor(weekAiResult.value);
    } else {
      setWeekAiAdvisor(null);
    }

    if (calendarStatusResult.status === "fulfilled") {
      setCalendarStatus(calendarStatusResult.value);
    } else {
      setCalendarStatus(null);
    }

    if (dayCalendarBlocksResult.status === "fulfilled") {
      setDayCalendarBlocks(dayCalendarBlocksResult.value);
      setActiveCalendarBlock((current) => {
        if (!current) return null;
        return dayCalendarBlocksResult.value.find((block) => block.id === current.id) ?? current;
      });
    } else {
      setDayCalendarBlocks([]);
    }

    if (weekCalendarBlocksResult.status === "fulfilled") {
      setWeekCalendarBlocks(weekCalendarBlocksResult.value);
    } else {
      setWeekCalendarBlocks([]);
    }

    if (errors.length > 0) {
      setError(errors.join(" "));
    }

    diagnostics.markRefresh();
    setLoading(false);
  }

  const todayScopeDate = useMemo(() => toScopeDate(startOfToday(new Date())), []);
  const [selectedScopeDate, setSelectedScopeDate] = useState(todayScopeDate);
  const selectedDayStart = useMemo(() => parseScopeDateLocal(selectedScopeDate), [selectedScopeDate]);
  const selectedDayEnd = useMemo(() => endOfToday(selectedDayStart), [selectedDayStart]);
  const selectedDayLabel = useMemo(() => formatScopeDateLabel(selectedScopeDate), [selectedScopeDate]);
  const selectedWeekScopeDate = useMemo(() => toWeekScopeDate(selectedDayStart), [selectedDayStart]);
  const selectedWeekLabel = useMemo(() => formatWeekRangeLabel(selectedWeekScopeDate), [selectedWeekScopeDate]);
  const currentWeekScopeDate = useMemo(() => toWeekScopeDate(startOfToday(new Date())), []);
  const isSelectedToday = selectedScopeDate === todayScopeDate;
  const isWeekSurface = surface === "week";
  const selectedDayRelation = selectedScopeDate > todayScopeDate ? "future" : selectedScopeDate < todayScopeDate ? "past" : "today";
  const dayIntroCopy =
    selectedDayRelation === "today"
      ? "День зібрано навколо задач із планованим стартом на сьогодні, без автоматичного підтягування беклогу."
      : selectedDayRelation === "future"
        ? "Обрана дата показує, що вже стоїть у плані на цей день, без автоматичного підтягування беклогу."
        : "Обрана дата показує, що було в плані на цей день, без автоматичного підтягування беклогу.";
  const dayFocusTitle =
    selectedDayRelation === "today"
      ? "Що робити зараз?"
      : selectedDayRelation === "future"
        ? "На що звернути увагу в цей день?"
        : "Що було головним у цей день?";
  const dayFocusEmptyLabel =
    selectedDayRelation === "today"
      ? "Немає чіткої головної рекомендації."
      : selectedDayRelation === "future"
        ? "Явної головної точки уваги для цього дня поки немає."
        : "Явної головної точки уваги для цього дня зараз не видно.";
  const scopeDate = selectedScopeDate;

  useEffect(() => {
    void loadToday();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionToken, selectedScopeDate]);

  useEffect(() => {
    if (!sessionToken || !activeTask || activeTask.calendar_sync_mode !== "app_managed" || !activeTask.calendar_event_id) {
      setCalendarInboundState(null);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const state = await inspectTaskCalendarInbound({ sessionToken, taskId: activeTask.id });
        if (!cancelled) setCalendarInboundState(state);
      } catch {
        if (!cancelled) setCalendarInboundState(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeTask?.id, activeTask?.calendar_event_id, activeTask?.calendar_sync_mode, sessionToken]);

  const scheduledToday = useMemo(() => {
    const relevant = items.filter((task) => {
      if (task.status === "done" || task.status === "cancelled") return false;
      return isScheduledForDay(task, selectedDayStart, selectedDayEnd);
    });
    return sortTasksByTimeField(relevant, "scheduled_for");
  }, [items, selectedDayEnd, selectedDayStart]);

  const overdueScheduled = useMemo(() => {
    const relevant = items.filter((task) => {
      if (task.status === "done" || task.status === "cancelled") return false;
      if (!task.scheduled_for) return false;
      return new Date(task.scheduled_for).getTime() < selectedDayStart.getTime();
    });
    return sortTasksByTimeField(relevant, "scheduled_for");
  }, [items, selectedDayStart]);

  const dueTodayWithoutSchedule = useMemo(() => {
    const relevant = items.filter((task) => {
      if (task.status === "done" || task.status === "cancelled") return false;
      if (!isBacklogTask(task)) return false;
      return isDueOnDay(task, selectedDayStart, selectedDayEnd);
    });
    return sortTasksByTimeField(relevant, "due_at");
  }, [items, selectedDayEnd, selectedDayStart]);

  const backlogItems = useMemo(
    () =>
      items.filter(
        (task) => task.status !== "done" && task.status !== "cancelled" && isBacklogTask(task)
      ),
    [items]
  );

  const pureBacklogItems = useMemo(() => {
    return backlogItems.filter((task) => !isDueOnDay(task, selectedDayStart, selectedDayEnd));
  }, [backlogItems, selectedDayEnd, selectedDayStart]);

  const todayKnownEstimateMinutes = useMemo(() => sumKnownEstimateMinutes(scheduledToday), [scheduledToday]);
  const showDayReviewPrompt = shouldShowDayReviewPrompt({
    isSelectedToday,
    openPlannedCount: scheduledToday.length,
    dueWithoutScheduleCount: dueTodayWithoutSchedule.length,
    worklogCount: planning?.dailyReview.worklogs.count ?? 0
  });
  const showWeekReviewPrompt = shouldShowWeekReviewPrompt({
    isCurrentWeek: selectedWeekScopeDate === currentWeekScopeDate,
    hasWeeklyReview: !!weekPlanning?.weeklyReview,
    weeklyWorklogCount: weekPlanning?.dailyReview.worklogs.count ?? 0,
    plannedCount: weekPlanning?.overload.plannedTodayCount ?? 0,
    backlogCount: weekPlanning?.overload.backlogCount ?? 0
  });
  const todayMissingEstimateCount = useMemo(() => countMissingEstimates(scheduledToday), [scheduledToday]);
  const planningTaskTypeSignals = planning?.overload.taskTypeSignals ?? [];
  const aiTaskTypeSignals = aiAdvisor?.contextSnapshot.taskTypeSignals ?? [];
  const weekPlanningTaskTypeSignals = weekPlanning?.overload.taskTypeSignals ?? [];
  const weekPlanningWeekDays = weekPlanning?.weekDays ?? [];
  const weekPlanningNotableDeadlines = weekPlanning?.notableDeadlines ?? [];
  const weekAiTaskTypeSignals = weekAiAdvisor?.contextSnapshot.taskTypeSignals ?? [];
  const weekAiWeekDays = weekAiAdvisor?.contextSnapshot.weekDays ?? [];
  const weekAiNotableDeadlines = weekAiAdvisor?.contextSnapshot.notableDeadlines ?? [];


  const weekResolveActions = useMemo<WeekResolveAction[]>(() => {
    const actions: WeekResolveAction[] = [];
    const review = weekPlanning?.weeklyReview;

    const pushReviewAction = (
      key: string,
      item: { taskId: string | null; title: string; reason: string } | undefined,
      actionLabel: string
    ) => {
      if (!item || actions.some((existing) => existing.key === key)) return;
      if (item.taskId) {
        const task = items.find((candidate) => candidate.id === item.taskId);
        if (task) {
          actions.push({
            key,
            title: item.title,
            reason: normalizePlanningCopy(item.reason),
            actionLabel,
            onClick: () => {
              setTaskModalMode("edit");
              setActiveTask(task);
              setError(null);
            }
          });
          return;
        }
      }

      actions.push({
        key,
        title: item.title,
        reason: normalizePlanningCopy(item.reason),
        actionLabel: "\u041e\u0431\u0433\u043e\u0432\u043e\u0440\u0438\u0442\u0438 \u0442\u0438\u0436\u0434\u0435\u043d\u044c",
        onClick: () => void openPlanningConversation("week")
      });
    };

    pushReviewAction("not_done", review?.notDone?.[0], "\u041f\u0456\u0434\u0433\u043e\u0442\u0443\u0432\u0430\u0442\u0438 \u0440\u0456\u0448\u0435\u043d\u043d\u044f");
    pushReviewAction("should_move", review?.shouldMove?.[0], "\u041f\u0456\u0434\u0433\u043e\u0442\u0443\u0432\u0430\u0442\u0438 \u043f\u0435\u0440\u0435\u043d\u0435\u0441\u0435\u043d\u043d\u044f");
    pushReviewAction("should_kill", review?.shouldKill?.[0], "\u041f\u0456\u0434\u0433\u043e\u0442\u0443\u0432\u0430\u0442\u0438 \u043f\u0440\u0438\u0431\u0438\u0440\u0430\u043d\u043d\u044f");
    pushReviewAction("moved", review?.moved?.[0], "\u041f\u0435\u0440\u0435\u0433\u043b\u044f\u043d\u0443\u0442\u0438 \u0437\u0430\u0434\u0430\u0447\u0443");

    if (actions.length === 0 && (weekPlanning?.overload.dueTodayWithoutPlannedStartCount ?? 0) > 0) {
      actions.push({
        key: "due_without_plan",
        title: "\u0404 \u0434\u0435\u0434\u043b\u0430\u0439\u043d\u0438 \u0431\u0435\u0437 \u043f\u043b\u0430\u043d\u0443",
        reason: "\u0423 \u0442\u0438\u0436\u043d\u0456 \u043b\u0438\u0448\u0438\u043b\u0438\u0441\u044c \u0437\u0430\u0434\u0430\u0447\u0456 \u0437 \u0434\u0435\u0434\u043b\u0430\u0439\u043d\u043e\u043c, \u0430\u043b\u0435 \u0431\u0435\u0437 \u043f\u043b\u0430\u043d\u043e\u0432\u0430\u043d\u043e\u0433\u043e \u0441\u0442\u0430\u0440\u0442\u0443.",
        actionLabel: "\u041e\u0431\u0433\u043e\u0432\u043e\u0440\u0438\u0442\u0438 \u0442\u0438\u0436\u0434\u0435\u043d\u044c",
        onClick: () => void openPlanningConversation("week")
      });
    }

    const notableDeadlineTaskId = weekPlanning?.notableDeadlines?.[0]?.taskId ?? null;
    if (actions.length === 0 && notableDeadlineTaskId) {
      const task = items.find((candidate) => candidate.id === notableDeadlineTaskId);
      if (task) {
        actions.push({
          key: "deadline_focus",
          title: task.title,
          reason: "\u0423 \u0446\u044c\u043e\u0433\u043e \u0442\u0438\u0436\u043d\u044f \u0454 \u043f\u043e\u043c\u0456\u0442\u043d\u0438\u0439 \u0434\u0435\u0434\u043b\u0430\u0439\u043d, \u044f\u043a\u0438\u0439 \u0432\u0430\u0440\u0442\u043e \u043f\u0435\u0440\u0435\u0432\u0456\u0440\u0438\u0442\u0438 \u0432\u0440\u0443\u0447\u043d\u0443.",
          actionLabel: "\u0412\u0456\u0434\u043a\u0440\u0438\u0442\u0438 \u0437\u0430\u0434\u0430\u0447\u0443",
          onClick: () => {
            setTaskModalMode("edit");
            setActiveTask(task);
            setError(null);
          }
        });
      }
    }

    return actions.slice(0, 3);
  }, [items, selectedScopeDate, selectedWeekScopeDate, sessionToken, weekPlanning]);

  const isLightWeek = useMemo(() => {
    const review = weekPlanning?.weeklyReview;
    const reviewSignalCount = review
      ? review.done.length + review.notDone.length + review.moved.length + review.shouldMove.length + review.shouldKill.length
      : 0;
    const plannedCount = weekPlanning?.overload.plannedTodayCount ?? weekAiAdvisor?.contextSnapshot.plannedTodayCount ?? 0;
    const dueCount = weekPlanning?.overload.dueTodayWithoutPlannedStartCount ?? weekAiAdvisor?.contextSnapshot.dueTodayWithoutPlannedStartCount ?? 0;
    const backlogCount = weekPlanning?.overload.backlogCount ?? weekAiAdvisor?.contextSnapshot.backlogCount ?? 0;
    const notableDeadlineCount = weekPlanningNotableDeadlines.length || weekAiNotableDeadlines.length || 0;

    return plannedCount === 0 && dueCount === 0 && backlogCount === 0 && notableDeadlineCount === 0 && reviewSignalCount === 0;
  }, [weekAiAdvisor, weekPlanning]);
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
    return dayCalendarBlocks.filter((block) => {
      const parsed = new Date(block.start_at);
      if (Number.isNaN(parsed.getTime())) return false;
      return parsed >= selectedDayStart && parsed <= selectedDayEnd;
    });
  }, [dayCalendarBlocks, selectedDayEnd, selectedDayStart]);

  const nextCalendarEvent = useMemo(() => {
    const sorted = [...dayCalendarBlocks].sort((a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime());
    return sorted.find((block) => {
      const ts = new Date(block.start_at).getTime();
      return Number.isFinite(ts) && ts > selectedDayEnd.getTime();
    });
  }, [dayCalendarBlocks, selectedDayEnd]);

  const todayTaskCreateDefaults = useMemo(
    () => ({
      scheduledFor: defaultScheduledForForSelectedDay({
        scopeDate: selectedScopeDate,
        isSelectedToday
      })
    }),
    [selectedScopeDate, isSelectedToday]
  );

  async function createTaskFromToday(payload: {
    title: string;
    details: string;
    projectId: string | null;
    taskType: TaskType;
    dueAt: string | null;
    scheduledFor: string | null;
    estimatedMinutes: number | null;
    planningFlexibility: TaskItem["planning_flexibility"];
  }): Promise<boolean> {
    if (!sessionToken) {
      setError("Спочатку авторизуйся в Інбоксі.");
      return false;
    }

    setWorkingTaskId("today_create_task");
    setError(null);
    diagnostics.trackAction("create_task_from_today", { scopeDate: selectedScopeDate });

    try {
      await createTask({
        sessionToken,
        title: payload.title,
        details: payload.details,
        projectId: payload.projectId,
        taskType: payload.taskType,
        dueAt: payload.dueAt,
        scheduledFor: payload.scheduledFor,
        estimatedMinutes: payload.estimatedMinutes,
        planningFlexibility: payload.planningFlexibility
      });
      await loadToday();
      return true;
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
      setError(saveError instanceof Error ? saveError.message : "Не вдалося створити задачу");
      return false;
    } finally {
      setWorkingTaskId(null);
    }
  }

  async function createNoteFromToday(payload: { title: string; body: string; projectId: string | null }): Promise<boolean> {
    if (!sessionToken) {
      setError("Спочатку авторизуйся в Інбоксі.");
      return false;
    }

    setNoteCreating(true);
    setError(null);
    diagnostics.trackAction("create_note_from_today", { scopeDate: selectedScopeDate });

    try {
      await createNote({
        sessionToken,
        title: payload.title || null,
        body: payload.body,
        projectId: payload.projectId
      });
      await loadToday();
      return true;
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
      setError(saveError instanceof Error ? saveError.message : "Не вдалося створити нотатку");
      return false;
    } finally {
      setNoteCreating(false);
    }
  }
  async function saveTaskUpdate(task: TaskItem, patch: {
    scheduledFor?: string | null;
    dueAt?: string | null;
    estimatedMinutes?: number | null;
    planningFlexibility?: TaskItem["planning_flexibility"];
    title?: string;
    details?: string | null;
    projectId?: string | null;
    taskType?: TaskType;
  }): Promise<boolean> {
    if (!sessionToken) {
      setError("Спочатку авторизуйся в Інбоксі.");
      return false;
    }

    setWorkingTaskId(task.id);
    setError(null);
    diagnostics.trackAction("update_task_fields", { taskId: task.id, source: "today" });

    try {
      await updateTask({
        sessionToken,
        taskId: task.id,
        title: patch.title ?? task.title,
        details: patch.details ?? task.details ?? "",
        projectId: patch.projectId !== undefined ? patch.projectId : task.project_id ?? null,
        taskType: patch.taskType ?? task.task_type,
        dueAt: patch.dueAt !== undefined ? patch.dueAt : task.due_at ?? null,
        scheduledFor: patch.scheduledFor !== undefined ? patch.scheduledFor : task.scheduled_for ?? null,
        estimatedMinutes: patch.estimatedMinutes !== undefined ? patch.estimatedMinutes : task.estimated_minutes ?? null,
        planningFlexibility:
          patch.planningFlexibility !== undefined ? patch.planningFlexibility : task.planning_flexibility ?? null
      });
      await loadToday();
      return true;
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
      setError(saveError instanceof Error ? saveError.message : "Не вдалося оновити задачу");
      return false;
    } finally {
      setWorkingTaskId(null);
    }
  }

  async function retryActiveTaskCalendarSync(task: TaskItem) {
    if (!sessionToken) return;

    setWorkingTaskId(task.id);
    setError(null);
    diagnostics.trackAction("retry_task_calendar_sync", { taskId: task.id, route: "/today" });

    try {
      await retryTaskCalendarSyncRequest({ sessionToken, taskId: task.id });
      setCalendarNotice({
        tone: "success",
        message: task.calendar_sync_error || !task.linked_calendar_event || !task.calendar_event_id ? "\u041f\u043e\u0434\u0456\u044e \u0432 Google Calendar \u0432\u0456\u0434\u043d\u043e\u0432\u043b\u0435\u043d\u043e." : "\u0421\u0438\u043d\u0445\u0440\u043e\u043d\u0456\u0437\u0430\u0446\u0456\u044e \u0437 \u043a\u0430\u043b\u0435\u043d\u0434\u0430\u0440\u0435\u043c \u043e\u043d\u043e\u0432\u043b\u0435\u043d\u043e."
      });
      await loadToday();
    } catch (retryError) {
      if (retryError instanceof ApiError) {
        diagnostics.trackFailure({
          path: retryError.path,
          status: retryError.status,
          code: retryError.code,
          message: retryError.message,
          details: retryError.details
        });
      }
      setError(retryError instanceof Error ? retryError.message : "Не вдалося пересинхронізувати задачу");
    } finally {
      setWorkingTaskId(null);
    }
  }

  async function applyInboundCalendarChange(task: TaskItem) {
    if (!sessionToken) {
      setError("Спочатку авторизуйся в Інбоксі.");
      return;
    }

    setWorkingTaskId(task.id);
    setError(null);
    diagnostics.trackAction("apply_task_calendar_inbound", { taskId: task.id, route: "/today" });

    try {
      const state = await applyTaskCalendarInbound({ sessionToken, taskId: task.id });
      setCalendarNotice({
        tone: "success",
        message: state.message ?? "Зміни з Google Calendar застосовано."
      });
      await loadToday();
    } catch (applyError) {
      if (applyError instanceof ApiError) {
        diagnostics.trackFailure({
          path: applyError.path,
          status: applyError.status,
          code: applyError.code,
          message: applyError.message,
          details: applyError.details
        });
      }
      setCalendarNotice({ tone: "error", message: "Не вдалося застосувати зміни з Google Calendar." });
      setError(applyError instanceof Error ? applyError.message : "Не вдалося застосувати зміни з Google Calendar.");
    } finally {
      setWorkingTaskId(null);
    }
  }
  async function keepCalendarAppVersion(task: TaskItem) {
    if (!sessionToken) {
      setError("Спочатку авторизуйся в Інбоксі.");
      return;
    }

    setWorkingTaskId(task.id);
    setError(null);
    diagnostics.trackAction("keep_task_calendar_app_version", { taskId: task.id, route: "/today" });

    try {
      const state = await keepTaskCalendarLocalVersion({ sessionToken, taskId: task.id });
      setCalendarNotice({
        tone: "success",
        message: state.message ?? "Версію з додатку збережено в Google Calendar."
      });
      await loadToday();
    } catch (keepError) {
      if (keepError instanceof ApiError) {
        diagnostics.trackFailure({
          path: keepError.path,
          status: keepError.status,
          code: keepError.code,
          message: keepError.message,
          details: keepError.details
        });
      }
      setCalendarNotice({ tone: "error", message: "Не вдалося залишити версію з додатку." });
      setError(keepError instanceof Error ? keepError.message : "Не вдалося залишити версію з додатку.");
    } finally {
      setWorkingTaskId(null);
    }
  }
  async function detachActiveTaskCalendarLink(task: TaskItem) {
    if (!sessionToken) {
      setError("Спочатку авторизуйся в Інбоксі.");
      return;
    }

    setWorkingTaskId(task.id);
    setError(null);
    diagnostics.trackAction("detach_task_calendar_link", { taskId: task.id, route: "/today" });

    try {
      await detachTaskCalendarLinkRequest({ sessionToken, taskId: task.id });
      setCalendarNotice({
        tone: "success",
        message: task.calendar_sync_mode === "app_managed" ? "\u0417\u0432\u2019\u044f\u0437\u043e\u043a \u0456\u0437 Google Calendar \u043f\u0440\u0438\u0431\u0440\u0430\u043d\u043e." : "\u041f\u043e\u0434\u0456\u044e \u0432\u0456\u0434\u2019\u0454\u0434\u043d\u0430\u043d\u043e \u0432\u0456\u0434 \u0437\u0430\u0434\u0430\u0447\u0456."
      });
      await loadToday();
    } catch (detachError) {
      if (detachError instanceof ApiError) {
        diagnostics.trackFailure({
          path: detachError.path,
          status: detachError.status,
          code: detachError.code,
          message: detachError.message,
          details: detachError.details
        });
      }
      setCalendarNotice({ tone: "error", message: "\u041d\u0435 \u0432\u0434\u0430\u043b\u043e\u0441\u044f \u0432\u0456\u0434\u2019\u0454\u0434\u043d\u0430\u0442\u0438 \u043f\u043e\u0434\u0456\u044e." });
      setError(detachError instanceof Error ? detachError.message : "\u041d\u0435 \u0432\u0434\u0430\u043b\u043e\u0441\u044f \u0432\u0456\u0434\u2019\u0454\u0434\u043d\u0430\u0442\u0438 \u043f\u043e\u0434\u0456\u044e.");
    } finally {
      setWorkingTaskId(null);
    }
  }

  function openCalendarBlock(block: CalendarBlockItem) {
    setCalendarBlockCreateOpen(false);
    setActiveCalendarBlock(block);
    setCalendarBlockError(null);
  }

  function startCreateCalendarBlock() {
    setActiveCalendarBlock(null);
    setCalendarBlockCreateOpen(true);
    setCalendarBlockError(null);
  }

  async function saveCalendarBlock(input: {
    title: string;
    description: string;
    startAt: string;
    endAt: string | null;
    timezone: string;
    projectId: string | null;
  }) {
    if (!sessionToken || !input.endAt) {
      setError("Спочатку авторизуйся в Інбоксі.");
      return;
    }

    setCalendarBlockBusy(true);
    setCalendarBlockError(null);
    diagnostics.trackAction("save_calendar_block_from_today", {
      blockId: activeCalendarBlock?.id ?? null,
      route: surface === "week" ? "/week" : "/today"
    });

    try {
      await upsertCalendarBlock({
        sessionToken,
        id: activeCalendarBlock?.id ?? null,
        title: input.title,
        details: input.description,
        startAt: input.startAt,
        endAt: input.endAt,
        timezone: input.timezone,
        projectId: input.projectId
      });
      setActiveCalendarBlock(null);
      await loadToday();
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
      setCalendarBlockError(saveError instanceof Error ? saveError.message : "Не вдалося зберегти блок у календарі.");
    } finally {
      setCalendarBlockBusy(false);
    }
  }

  async function deleteActiveCalendarBlock() {
    if (!sessionToken || !activeCalendarBlock) {
      setError("Спочатку авторизуйся в Інбоксі.");
      return;
    }

    const confirmed = window.confirm("Видалити цей блок із календаря?");
    if (!confirmed) return;

    setCalendarBlockBusy(true);
    setCalendarBlockError(null);
    diagnostics.trackAction("delete_calendar_block_from_today", {
      blockId: activeCalendarBlock.id,
      route: surface === "week" ? "/week" : "/today"
    });

    try {
      await deleteCalendarBlock({ sessionToken, id: activeCalendarBlock.id });
      setActiveCalendarBlock(null);
      await loadToday();
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
      setCalendarBlockError(deleteError instanceof Error ? deleteError.message : "Не вдалося видалити блок із календаря.");
    } finally {
      setCalendarBlockBusy(false);
    }
  }

  async function openPlanningConversation(scopeType: PlanningConversationScopeType = "day") {
    if (!sessionToken) {
      setError("Спочатку авторизуйся в Інбоксі.");
      return;
    }

    const targetScopeDate = scopeType === "week" ? selectedWeekScopeDate : scopeDate;

    setPlanningConversationScopeType(scopeType);
    setPlanningConversationOpen(true);
    setPlanningConversation(null);
    setPlanningConversationBusy(true);
    setPlanningConversationError(null);
    diagnostics.trackAction("open_planning_conversation", { scopeType, scopeDate: targetScopeDate });

    try {
      const state = await getPlanningConversation({ sessionToken, scopeType, scopeDate: targetScopeDate });
      setPlanningConversation(state);
    } catch (conversationError) {
      if (conversationError instanceof ApiError) {
        diagnostics.trackFailure({
          path: conversationError.path,
          status: conversationError.status,
          code: conversationError.code,
          message: conversationError.message,
          details: conversationError.details
        });
      }
      setPlanningConversationError(
        conversationError instanceof Error ? conversationError.message : "Не вдалося відкрити обговорення плану"
      );
    } finally {
      setPlanningConversationBusy(false);
    }
  }

  function openTaskFromWeeklyReview(taskId: string | null) {
    if (!taskId) return;
    const task = items.find((item) => item.id === taskId);
    if (!task) return;
    setTaskModalMode("edit");
    setActiveTask(task);
    setError(null);
  }

  function renderWeeklyReviewSection(
    label: string,
    sectionKey: keyof NonNullable<PlanningSummary["weeklyReview"]>,
    options?: {
      showWeekConversationAction?: boolean;
      taskActionLabel?: string;
      decisionHint?: string;
    }
  ) {
    const review = weekPlanning?.weeklyReview;
    if (!review) return null;

    const itemsForSection = review[sectionKey];
    return (
      <div key={sectionKey}>
        <p className="assistant-title">{label}</p>
        {itemsForSection.length > 0 ? (
          <ul className="assistant-secondary">
            {itemsForSection.map((item, index) => {
              const taskExists = item.taskId ? items.some((task) => task.id === item.taskId) : false;
              return (
                <li key={`${sectionKey}-${item.taskId ?? item.title}-${index}`}>
                  <strong>{item.title}</strong>
                  <span> - {normalizePlanningCopy(item.reason)}</span>
                  {options?.decisionHint ? <p className="inbox-meta">{options.decisionHint}</p> : null}
                  {(taskExists || options?.showWeekConversationAction) ? (
                    <div className="inbox-actions">
                      {taskExists ? (
                        <button
                          type="button"
                          className="ghost"
                          onClick={() => openTaskFromWeeklyReview(item.taskId)}
                          disabled={workingTaskId !== null}
                        >
                          {options?.taskActionLabel ?? "Відкрити задачу"}
                        </button>
                      ) : null}
                      {options?.showWeekConversationAction ? (
                        <button
                          type="button"
                          className="ghost"
                          onClick={() => void openPlanningConversation("week")}
                          disabled={!sessionToken || planningConversationBusy}
                        >
                          Обговорити тиждень
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="empty-note">{weeklyReviewEmptyLabel(sectionKey)}</p>
        )}
      </div>
    );
  }

  async function sendPlanningMessage(message: string) {
    if (!sessionToken || !planningConversation) return;

    setPlanningConversationBusy(true);
    setPlanningConversationError(null);
    diagnostics.trackAction("planning_conversation_turn", {
      scopeType: planningConversation.session.scopeType,
      scopeDate: planningConversation.session.scopeDate
    });

    try {
      const state = await sendPlanningConversationTurn({
        sessionToken,
        scopeType: planningConversation.session.scopeType,
        scopeDate: planningConversation.session.scopeDate,
        sessionId: planningConversation.session.id,
        message
      });
      setPlanningConversation(state);
    } catch (conversationError) {
      if (conversationError instanceof ApiError) {
        diagnostics.trackFailure({
          path: conversationError.path,
          status: conversationError.status,
          code: conversationError.code,
          message: conversationError.message,
          details: conversationError.details
        });
      }
      setPlanningConversationError(
        conversationError instanceof Error ? conversationError.message : "Не вдалося надіслати коментар до плану"
      );
    } finally {
      setPlanningConversationBusy(false);
    }
  }

  async function transcribePlanningConversationVoice(file: File): Promise<string> {
    if (!sessionToken) {
      throw new Error("Спочатку авторизуйся в Інбоксі.");
    }

    diagnostics.trackAction("planning_conversation_voice_transcribe", {
      scopeDate,
      size: file.size,
      type: file.type || "unknown"
    });

    try {
      return await transcribePlanningVoice({ sessionToken, file });
    } catch (voiceError) {
      if (voiceError instanceof ApiError) {
        diagnostics.trackFailure({
          path: voiceError.path,
          status: voiceError.status,
          code: voiceError.code,
          message: voiceError.message,
          details: voiceError.details
        });
      }
      throw voiceError instanceof Error
        ? voiceError
        : new Error("Не вдалося розпізнати голос. Спробуй ще раз.");
    }
  }

  async function actOnLatestProposalSet(action: "apply_all_latest" | "dismiss_all_latest") {
    if (!sessionToken || !planningConversation?.latestActionableAssistantMessageId) return;

    setPlanningConversationBusy(true);
    setPlanningConversationError(null);
    diagnostics.trackAction("planning_proposal_set_action", {
      assistantMessageId: planningConversation.latestActionableAssistantMessageId,
      action
    });

    try {
      const state = await updatePlanningProposal({
        sessionToken,
        assistantMessageId: planningConversation.latestActionableAssistantMessageId,
        action
      });
      setPlanningConversation(state);
      if (action === "apply_all_latest") {
        await loadToday();
      }
    } catch (conversationError) {
      if (conversationError instanceof ApiError) {
        diagnostics.trackFailure({
          path: conversationError.path,
          status: conversationError.status,
          code: conversationError.code,
          message: conversationError.message,
          details: conversationError.details
        });
      }
      setPlanningConversationError(
        action === "apply_all_latest"
          ? "Не вдалося застосувати весь набір пропозицій."
          : "Не вдалося відхилити набір пропозицій."
      );
    } finally {
      setPlanningConversationBusy(false);
    }
  }

  async function actOnProposal(proposalId: string, action: "apply" | "dismiss") {
    if (!sessionToken) return;

    setActingProposalId(proposalId);
    setPlanningConversationBusy(true);
    setPlanningConversationError(null);
    diagnostics.trackAction("planning_proposal_action", { proposalId, action });

    try {
      const state = await updatePlanningProposal({ sessionToken, proposalId, action });
      setPlanningConversation(state);
      if (action === "apply") {
        await loadToday();
      }
    } catch (conversationError) {
      if (conversationError instanceof ApiError) {
        diagnostics.trackFailure({
          path: conversationError.path,
          status: conversationError.status,
          code: conversationError.code,
          message: conversationError.message,
          details: conversationError.details
        });
      }
      setPlanningConversationError(
        action === "apply"
          ? "Не вдалося застосувати пропозицію."
          : "Не вдалося відхилити пропозицію."
      );
    } finally {
      setActingProposalId(null);
      setPlanningConversationBusy(false);
    }
  }

  function scheduleForSelectedDay(task: TaskItem) {
    const scheduledAt = isSelectedToday
      ? new Date().toISOString()
      : new Date(scopeDate + "T09:00:00").toISOString();
    void saveTaskUpdate(task, { scheduledFor: scheduledAt });
  }

  function returnToBacklog(task: TaskItem) {
    void saveTaskUpdate(task, { scheduledFor: null });
  }

  function renderActions(task: TaskItem, mode: "scheduled" | "unscheduled" | "neutral") {
    const isBusy = workingTaskId === task.id;
    return (
      <div className="inbox-actions">
        {mode === "unscheduled" ? (
          <button type="button" className="ghost" onClick={() => scheduleForSelectedDay(task)} disabled={isBusy}>
            {isBusy ? "\u0417\u0431\u0435\u0440\u0435\u0436\u0435\u043d\u043d\u044f..." : isSelectedToday ? "\u0417\u0430\u043f\u043b\u0430\u043d\u0443\u0432\u0430\u0442\u0438 \u043d\u0430 \u0441\u044c\u043e\u0433\u043e\u0434\u043d\u0456" : "\u0417\u0430\u043f\u043b\u0430\u043d\u0443\u0432\u0430\u0442\u0438 \u043d\u0430 \u0434\u0435\u043d\u044c"}
          </button>
        ) : null}
        {mode === "scheduled" ? (
          <button type="button" className="ghost" onClick={() => returnToBacklog(task)} disabled={isBusy}>
            {isBusy ? "Збереження..." : "Повернути в беклог"}
          </button>
        ) : null}
        <button type="button" className="ghost" onClick={() => setActiveTask(task)} disabled={isBusy}>
          {needsPlanningTouch(task) ? "Дописати план" : "Редагувати"}
        </button>
      </div>
    );
  }

  function renderSection(
    title: string,
    description: string,
    list: TaskItem[],
    actionMode: "scheduled" | "unscheduled" | "neutral"
  ) {
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
                  {task.planning_flexibility ? (
                    <span className={`planning-badge planning-badge--${task.planning_flexibility}`}>
                      {planningFlexibilityLabel(task.planning_flexibility)}
                    </span>
                  ) : null}
                  {task.is_protected_essential ? <span className="essential-badge">Захищене важливе</span> : null}
                </p>
                <p className="inbox-meta">
                  {projectName(task)} · {taskTypeLabel(task.task_type)} · {task.status === "blocked" ? "Заблоковано" : task.status === "in_progress" ? "В роботі" : "Заплановано"}
                </p>
                <p className="inbox-meta">{formatTaskTimingSummary(task)}</p>
                {calendarLinkHint(task) ? <p className="inbox-meta">{calendarLinkHint(task)}</p> : null}
                {renderActions(task, actionMode)}
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="today-toolbar">
        <div>
          <h2>{isWeekSurface ? "Тиждень" : isSelectedToday ? "Сьогодні" : "План дня"}</h2>
          <p className="inbox-meta">{isWeekSurface ? selectedWeekLabel : selectedDayLabel}</p>
        </div>
        <div className="today-toolbar__actions">
          <button type="button" className="ghost" onClick={() => setSelectedScopeDate((current) => shiftScopeDate(current, isWeekSurface ? -7 : -1))}>
            {isWeekSurface ? "Попередній тиждень" : "Попередній день"}
          </button>
          <input
            type="date"
            value={isWeekSurface ? selectedWeekScopeDate : selectedScopeDate}
            onChange={(event) => setSelectedScopeDate(event.target.value || (isWeekSurface ? currentWeekScopeDate : todayScopeDate))}
          />
          {(isWeekSurface ? selectedWeekScopeDate !== currentWeekScopeDate : !isSelectedToday) ? (
            <button type="button" className="ghost" onClick={() => setSelectedScopeDate(isWeekSurface ? currentWeekScopeDate : todayScopeDate)}>
              {isWeekSurface ? "Цей тиждень" : "Сьогодні"}
            </button>
          ) : null}
          <button type="button" className="ghost" onClick={() => setSelectedScopeDate((current) => shiftScopeDate(current, isWeekSurface ? 7 : 1))}>
            {isWeekSurface ? "Наступний тиждень" : "Наступний день"}
          </button>
        </div>
      </div>
      <div className="today-toolbar__actions today-toolbar__actions--primary">
        {isWeekSurface ? (
          <>
            <button type="button" onClick={() => void openPlanningConversation("week")} disabled={!sessionToken || planningConversationBusy}>
              {"Обговорити тиждень"}
            </button>
            <button type="button" className="ghost" onClick={() => startCreateCalendarBlock()} disabled={!sessionToken || calendarBlockBusy}>
              {"Створити блок"}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => {
                setTaskModalMode("create");
                setActiveTask(null);
              }}
              disabled={!sessionToken || workingTaskId !== null || noteCreating}
            >
              Створити задачу
            </button>
            <button type="button" onClick={() => void openPlanningConversation("day")} disabled={!sessionToken || planningConversationBusy}>
              {"Обговорити день"}
            </button>
          </>
        )}
      </div>
      <p>
        {isWeekSurface
          ? "Тут зібрано тижневий план, огляд і ручні follow-up рішення, без змішування із денним execution flow."
          : dayIntroCopy}
      </p>
      {!isWeekSurface ? (
        <div className="today-toolbar__actions today-toolbar__actions--secondary">
          <button
            type="button"
            className="ghost"
            onClick={() => setNoteCreateOpen(true)}
            disabled={!sessionToken || noteCreating || workingTaskId !== null}
          >
            Створити нотатку
          </button>
        </div>
      ) : null}

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

      {!isWeekSurface && planning ? (
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
          {planningTaskTypeSignals.length > 0 ? (
            <p className="inbox-meta">{normalizePlanningCopy(planningTaskTypeSignals.slice(0, 2).join(" "))}</p>
          ) : null}

          <h3>Що робити зараз?</h3>
          {planning.whatNow.primary ? (
            <div className="assistant-primary">
              <p className="assistant-title">Пріоритет: {planning.whatNow.primary.title}</p>
              <p className="inbox-meta">{normalizePlanningCopy(planning.whatNow.primary.reason)}</p>
            </div>
          ) : (
            <p className="empty-note">Немає чіткої головної рекомендації.</p>
          )}

          {planning.whatNow.secondary.length > 0 ? (
            <ul className="assistant-secondary">
              {planning.whatNow.secondary.map((item, index) => (
                <li key={`${item.title}-${index}`}>
                  <strong>{item.title}</strong>
                  <span> - {normalizePlanningCopy(item.reason)}</span>
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
                <li key={flag.code}>{normalizePlanningCopy(flag.message)}</li>
              ))}
            </ul>
          )}

          <h3>Щоденний підсумок</h3>
          <p className="inbox-meta">
            Виконано: {planning.dailyReview.completedTodayCount} · Перенесено: {planning.dailyReview.movedTodayCount} ·
            Скасовано: {planning.dailyReview.cancelledTodayCount} · Пропущено захищених:{" "}
            {planning.dailyReview.protectedEssentialsMissedToday}
          </p>
          <p className="inbox-meta">{formatWorklogSummary(planning.dailyReview.worklogs)}</p>
          {formatWorklogSources(planning.dailyReview.worklogs.sourceCounts) ? (
            <p className="inbox-meta">{formatWorklogSources(planning.dailyReview.worklogs.sourceCounts)}</p>
          ) : null}
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
                {risk.title} ({normalizePlanningCopy(risk.reason)})
              </li>
            ))}
            {planning.essentialRisk.recurringEssentialRisk.slice(0, 3).map((risk) => (
              <li key={`r-${risk.taskId}`}>
                {risk.title} ({normalizePlanningCopy(risk.reason)})
              </li>
            ))}
            {planning.essentialRisk.squeezedOutRisk.slice(0, 3).map((risk) => (
              <li key={`s-${risk.taskId}`}>
                {risk.title} ({normalizePlanningCopy(risk.reason)})
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

      {!isWeekSurface && aiAdvisor ? (
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

          <p className="assistant-title">{normalizePlanningCopy(aiAdvisor.advisor.whatMattersMostNow)}</p>
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
          {aiTaskTypeSignals.length > 0 ? (
            <p className="inbox-meta">{normalizePlanningCopy(aiTaskTypeSignals.slice(0, 2).join(" "))}</p>
          ) : null}

          <div className="assistant-primary">
            <p className="assistant-title">Рекомендована наступна дія: {aiAdvisor.advisor.suggestedNextAction.title}</p>
            <p className="inbox-meta">{normalizePlanningCopy(aiAdvisor.advisor.suggestedNextAction.reason)}</p>
          </div>

          <div className="assistant-primary">
            <p className="assistant-title">Що варто відкласти: {aiAdvisor.advisor.suggestedDefer.title}</p>
            <p className="inbox-meta">{normalizePlanningCopy(aiAdvisor.advisor.suggestedDefer.reason)}</p>
          </div>

          <p className={aiAdvisor.advisor.protectedEssentialsWarning.hasWarning ? "error-note" : "inbox-meta"}>
            {normalizePlanningCopy(aiAdvisor.advisor.protectedEssentialsWarning.message)}
          </p>
          <p className="inbox-meta">{normalizePlanningCopy(aiAdvisor.advisor.explanation)}</p>
          <p className="inbox-meta">{formatWorklogSummary(aiAdvisor.contextSnapshot.worklogs)}</p>
          {formatWorklogSources(aiAdvisor.contextSnapshot.worklogs.sourceCounts) ? (
            <p className="inbox-meta">{formatWorklogSources(aiAdvisor.contextSnapshot.worklogs.sourceCounts)}</p>
          ) : null}
        </section>
      ) : null}


      {isWeekSurface && !loading ? (
        <section className="today-disclosure">
          <div className="today-disclosure__header">
            <strong>{selectedWeekScopeDate === currentWeekScopeDate ? "\u041f\u043e\u0442\u043e\u0447\u043d\u0438\u0439 \u0442\u0438\u0436\u0434\u0435\u043d\u044c" : "\u0412\u0438\u0431\u0440\u0430\u043d\u0438\u0439 \u0442\u0438\u0436\u0434\u0435\u043d\u044c"}</strong>
            <p className="inbox-meta">{selectedWeekLabel}. {"\u0422\u0443\u0442 \u0437\u0440\u0443\u0447\u043d\u0456\u0448\u0435 \u0432\u0438\u0440\u0456\u0448\u0443\u0432\u0430\u0442\u0438 \u0442\u0438\u0436\u043d\u0435\u0432\u0456 \u043f\u0435\u0440\u0435\u043d\u0435\u0441\u0435\u043d\u043d\u044f, \u0434\u0435\u0434\u043b\u0430\u0439\u043d\u0438 \u0431\u0435\u0437 \u043f\u043b\u0430\u043d\u0443 \u0456 cleanup, \u043d\u0435 \u0437\u043c\u0456\u0448\u0443\u044e\u0447\u0438 \u0446\u0435 \u0437 \u0434\u0435\u043d\u043d\u0438\u043c \u0444\u043e\u043a\u0443\u0441\u043e\u043c."}</p>
          </div>
          <div className="today-toolbar__actions today-toolbar__actions--secondary">
            <button type="button" className="ghost" onClick={() => void openPlanningConversation("week")} disabled={!sessionToken || planningConversationBusy}>
              {"\u041e\u0431\u0433\u043e\u0432\u043e\u0440\u0438\u0442\u0438 \u0442\u0438\u0436\u0434\u0435\u043d\u044c"}
            </button>
            <button type="button" className="ghost" onClick={() => navigate("/tasks")}>
              {"\u041f\u0435\u0440\u0435\u0433\u043b\u044f\u043d\u0443\u0442\u0438 \u0437\u0430\u0434\u0430\u0447\u0456"}
            </button>
            <button type="button" className="ghost" onClick={() => navigate("/worklogs")}>
              {"\u0414\u043e\u0434\u0430\u0442\u0438 \u043a\u043e\u043d\u0442\u0435\u043a\u0441\u0442"}
            </button>
          </div>

          <section className="assistant-block">
            <h3>{"\u0429\u043e \u0432\u0430\u0440\u0442\u043e \u0432\u0438\u0440\u0456\u0448\u0438\u0442\u0438 \u0446\u044c\u043e\u0433\u043e \u0442\u0438\u0436\u043d\u044f"}</h3>
            {weekResolveActions.length > 0 ? (
              <ul className="assistant-secondary">
                {weekResolveActions.map((item) => (
                  <li key={item.key}>
                    <strong>{item.title}</strong>
                    <span> - {item.reason}</span>
                    <div className="inbox-actions">
                      <button type="button" className="ghost" onClick={item.onClick} disabled={workingTaskId !== null || planningConversationBusy}>
                        {item.actionLabel}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : isLightWeek ? (
              <>
                <p className="empty-note">{"\u0422\u0438\u0436\u0434\u0435\u043d\u044c \u043f\u043e\u043a\u0438 \u0432\u0438\u0433\u043b\u044f\u0434\u0430\u0454 \u043b\u0435\u0433\u043a\u0438\u043c: \u044f\u0432\u043d\u043e\u0433\u043e \u0442\u0438\u0441\u043a\u0443, \u0434\u0435\u0434\u043b\u0430\u0439\u043d\u0456\u0432 \u0431\u0435\u0437 \u043f\u043b\u0430\u043d\u0443 \u0447\u0438 \u0445\u0432\u043e\u0441\u0442\u0430 \u043f\u0435\u0440\u0435\u043d\u0435\u0441\u0435\u043d\u044c \u043d\u0435 \u0432\u0438\u0434\u043d\u043e."}</p>
                <p className="inbox-meta">{"\u041d\u0430\u0439\u043a\u0440\u0430\u0449\u0438\u0439 \u0440\u0443\u0447\u043d\u0438\u0439 next step \u0442\u0443\u0442 - \u0430\u0431\u043e \u043a\u043e\u0440\u043e\u0442\u043a\u043e \u0437\u0432\u0456\u0440\u0438\u0442\u0438 \u0442\u0438\u0436\u0434\u0435\u043d\u044c \u0437 \u0431\u0435\u043a\u043b\u043e\u0433\u043e\u043c, \u0430\u0431\u043e \u0434\u043e\u0434\u0430\u0442\u0438 \u043a\u043e\u043d\u0442\u0435\u043a\u0441\u0442, \u043f\u043e\u043a\u0438 \u0432\u0456\u043d \u0449\u0435 \u0441\u0432\u0456\u0436\u0438\u0439."}</p>
              </>
            ) : (
              <p className="empty-note">{"\u042f\u0432\u043d\u043e\u0457 \u043a\u0440\u0438\u0442\u0438\u0447\u043d\u043e\u0457 \u0442\u043e\u0447\u043a\u0438 \u0442\u0438\u0441\u043a\u0443 \u043f\u043e \u0442\u0438\u0436\u043d\u044e \u0437\u0430\u0440\u0430\u0437 \u043d\u0435 \u0432\u0438\u0434\u043d\u043e. \u041c\u043e\u0436\u043d\u0430 \u0448\u0432\u0438\u0434\u043a\u043e \u0437\u0432\u0456\u0440\u0438\u0442\u0438 \u043f\u043b\u0430\u043d \u0442\u0438\u0436\u043d\u044f \u0430\u0431\u043e \u043f\u0440\u043e\u0439\u0442\u0438\u0441\u044c \u043f\u043e \u043e\u0433\u043b\u044f\u0434\u0443 \u043d\u0438\u0436\u0447\u0435."}</p>
            )}
          </section>

          <section className="today-section block-section">
            <div className="block-section__header">
              <div>
                <h3>Блоки тижня</h3>
                <p className="inbox-meta">Події й часові блоки, які формують реальний каркас тижня.</p>
              </div>
              <button type="button" className="ghost" onClick={() => startCreateCalendarBlock()} disabled={!sessionToken || calendarBlockBusy}>
                Додати блок
              </button>
            </div>
            {!calendarStatus?.connected ? (
              <p className="empty-note">Google Calendar не підключено. Підключи його на вкладці «Календар».</p>
            ) : weekCalendarBlocks.length === 0 ? (
              <p className="empty-note">На цей тиждень блоків поки не видно.</p>
            ) : (
              <ul className="inbox-list">
                {weekCalendarBlocks.slice(0, 8).map((block) => (
                  <li className="inbox-item block-row" key={block.id}>
                    <p className="inbox-main-text">{block.title}</p>
                    <p className="inbox-meta">{formatCalendarEventTimeRange(block)}</p>
                    <p className="inbox-meta block-row__meta">{block.source === "google" ? "Подія з Google Calendar" : "Блок із додатку"} · Проєкт: {projectNameForCalendarBlock(block)}</p>
                    <div className="inbox-actions">
                      <button type="button" className="ghost" onClick={() => openCalendarBlock(block)} disabled={calendarBlockBusy}>
                        Відкрити
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {weekPlanning ? (
            <section className="assistant-block deterministic-block">
              <h3>{"\u041f\u043b\u0430\u043d \u0442\u0438\u0436\u043d\u044f"}</h3>
              <p className="inbox-meta">{"\u0422\u0438\u0436\u0434\u0435\u043d\u044c:"} {selectedWeekLabel}</p>
              {diagnostics.debugEnabled ? (
                <p className="inbox-meta">
                  {"\u041f\u0440\u0430\u0432\u0438\u043b\u0430:"} {weekPlanning.rulesVersion} {" / "} {"\u0422\u0430\u0439\u043c\u0437\u043e\u043d\u0430:"} {weekPlanning.timezone}
                </p>
              ) : null}
              <p className="inbox-meta">
                {"\u0423 \u043f\u043b\u0430\u043d\u0456 \u0442\u0438\u0436\u043d\u044f:"} {weekPlanning.overload.plannedTodayCount} {" / "} {"\u0414\u0435\u0434\u043b\u0430\u0439\u043d\u0438 \u0431\u0435\u0437 \u043f\u043b\u0430\u043d\u0443:"} {weekPlanning.overload.dueTodayWithoutPlannedStartCount} {" / "} {"\u0411\u0435\u043a\u043b\u043e\u0433:"} {weekPlanning.overload.backlogCount}
              </p>
              <p className="inbox-meta">
                {weekLoadCoverageLine({
                  knownMinutes: weekPlanning.overload.scheduledKnownEstimateMinutes,
                  missingCount: weekPlanning.overload.scheduledMissingEstimateCount,
                  plannedCount: weekPlanning.overload.plannedTodayCount
                })}
              </p>
              {weekPlanningTaskTypeSignals.length > 0 ? (
                <p className="inbox-meta">{normalizePlanningCopy(weekPlanningTaskTypeSignals.slice(0, 2).join(" "))}</p>
              ) : null}
              {weekPlanning.whatNow.primary ? (
                <div className="assistant-primary">
                  <p className="assistant-title">{"\u0424\u043e\u043a\u0443\u0441 \u0442\u0438\u0436\u043d\u044f:"} {weekPlanning.whatNow.primary.title}</p>
                  <p className="inbox-meta">{normalizePlanningCopy(weekPlanning.whatNow.primary.reason)}</p>
                </div>
              ) : (
                <p className="empty-note">{"\u042f\u0432\u043d\u043e\u0457 \u0433\u043e\u043b\u043e\u0432\u043d\u043e\u0457 \u0442\u043e\u0447\u043a\u0438 \u0442\u0438\u0441\u043a\u0443 \u043f\u043e \u0442\u0438\u0436\u043d\u044e \u0437\u0430\u0440\u0430\u0437 \u043d\u0435\u043c\u0430\u0454."}</p>
              )}
              {weekPlanning.whatNow.secondary.length > 0 ? (
                <ul className="assistant-secondary">
                  {weekPlanning.whatNow.secondary.map((item, index) => (
                    <li key={`${item.title}-${index}`}>
                      <strong>{item.title}</strong>
                      <span> - {normalizePlanningCopy(item.reason)}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {weekPlanningWeekDays.length > 0 ? (
                <>
                  <h3>{"\u041a\u0430\u0440\u0442\u0438\u043d\u0430 \u0442\u0438\u0436\u043d\u044f"}</h3>
                  <ul className="assistant-secondary">
                    {weekPlanningWeekDays.map((day) => (
                      <li key={day.scopeDate}>{formatWeekDaySummary(day)}</li>
                    ))}
                  </ul>
                </>
              ) : null}
              {weekPlanningNotableDeadlines.length > 0 ? (
                <>
                  <h3>{"\u041f\u043e\u043c\u0456\u0442\u043d\u0456 \u0434\u0435\u0434\u043b\u0430\u0439\u043d\u0438 \u0442\u0438\u0436\u043d\u044f"}</h3>
                  <ul className="assistant-secondary">
                    {weekPlanningNotableDeadlines.slice(0, 5).map((item) => (
                      <li key={item.taskId}>
                        {item.title} {" / "} {formatTaskDateTime(new Date(item.dueAt))}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
              <p className="inbox-meta">{formatWorklogSummary(weekPlanning.dailyReview.worklogs)}</p>
              {weekPlanning.weeklyReview ? (
                <>
                  <h3>{"\u0427\u0435\u0440\u043d\u0435\u0442\u043a\u0430 \u043e\u0433\u043b\u044f\u0434\u0443 \u0442\u0438\u0436\u043d\u044f"}</h3>
                  {renderWeeklyReviewSection("\u0417\u0440\u043e\u0431\u043b\u0435\u043d\u043e", "done", { taskActionLabel: "\u0412\u0456\u0434\u043a\u0440\u0438\u0442\u0438" })}
                  {renderWeeklyReviewSection("\u041d\u0435 \u0437\u0430\u043a\u0440\u0438\u0442\u043e", "notDone", {
                    taskActionLabel: "\u041f\u0456\u0434\u0433\u043e\u0442\u0443\u0432\u0430\u0442\u0438 \u0440\u0456\u0448\u0435\u043d\u043d\u044f",
                    showWeekConversationAction: true,
                    decisionHint: "\u0426\u0435 \u0449\u0435 \u043d\u0435 \u0432\u0438\u0440\u043e\u043a. \u0422\u0443\u0442 \u0432\u0430\u0440\u0442\u043e \u0430\u0431\u043e \u0441\u0432\u0456\u0434\u043e\u043c\u043e \u043f\u0435\u0440\u0435\u043d\u0435\u0441\u0442\u0438, \u0430\u0431\u043e \u043f\u0440\u0438\u0431\u0440\u0430\u0442\u0438 \u0442\u0438\u0441\u043a \u0456\u0437 \u0437\u0430\u0434\u0430\u0447\u0456 \u0432\u0440\u0443\u0447\u043d\u0443."
                  })}
                  {renderWeeklyReviewSection("\u0417\u0441\u0443\u043d\u0443\u043b\u043e\u0441\u044c", "moved", {
                    showWeekConversationAction: true,
                    taskActionLabel: "\u041f\u0435\u0440\u0435\u0433\u043b\u044f\u043d\u0443\u0442\u0438 \u0437\u0430\u0434\u0430\u0447\u0443"
                  })}
                  {renderWeeklyReviewSection("\u0419\u043c\u043e\u0432\u0456\u0440\u043d\u043e \u0432\u0430\u0440\u0442\u043e \u043f\u0435\u0440\u0435\u043d\u0435\u0441\u0442\u0438", "shouldMove", {
                    showWeekConversationAction: true,
                    taskActionLabel: "\u041f\u0456\u0434\u0433\u043e\u0442\u0443\u0432\u0430\u0442\u0438 \u043f\u0435\u0440\u0435\u043d\u0435\u0441\u0435\u043d\u043d\u044f"
                  })}
                  {renderWeeklyReviewSection("\u0419\u043c\u043e\u0432\u0456\u0440\u043d\u043e \u0432\u0430\u0440\u0442\u043e \u043f\u0440\u0438\u0431\u0440\u0430\u0442\u0438", "shouldKill", {
                    taskActionLabel: "\u041f\u0456\u0434\u0433\u043e\u0442\u0443\u0432\u0430\u0442\u0438 \u043f\u0440\u0438\u0431\u0438\u0440\u0430\u043d\u043d\u044f",
                    showWeekConversationAction: true,
                    decisionHint: "\u0426\u0435 \u043b\u0438\u0448\u0435 \u043f\u0456\u0434\u043a\u0430\u0437\u043a\u0430 \u043d\u0430 cleanup. \u041e\u0441\u0442\u0430\u0442\u043e\u0447\u043d\u0435 \u0440\u0456\u0448\u0435\u043d\u043d\u044f \u043f\u0440\u043e \u0432\u0438\u0434\u0430\u043b\u0435\u043d\u043d\u044f, \u0441\u043a\u0430\u0441\u0443\u0432\u0430\u043d\u043d\u044f \u0447\u0438 \u0437\u043c\u0456\u043d\u0443 \u0437\u0430\u0434\u0430\u0447\u0456 \u043b\u0438\u0448\u0430\u0454\u0442\u044c\u0441\u044f \u0437\u0430 \u0442\u043e\u0431\u043e\u044e."
                  })}
                </>
              ) : null}
            </section>
          ) : null}

          {weekAiAdvisor ? (
            <section className="assistant-block ai-block">
              <h3>{"\u041f\u043e\u0440\u0430\u0434\u0430 AI \u043d\u0430 \u0442\u0438\u0436\u0434\u0435\u043d\u044c"}</h3>
              <p className="inbox-meta">{"\u0422\u0438\u0436\u0434\u0435\u043d\u044c:"} {selectedWeekLabel}</p>
              {diagnostics.debugEnabled ? (
                <p className="inbox-meta">
                  {"\u0414\u0436\u0435\u0440\u0435\u043b\u043e:"} {weekAiAdvisor.source === "ai" ? `OpenAI (${weekAiAdvisor.model ?? "\u043d\u0435\u0432\u0456\u0434\u043e\u043c\u0430 \u043c\u043e\u0434\u0435\u043b\u044c"})` : "\u0420\u0435\u0437\u0435\u0440\u0432\u043d\u0456 \u043f\u0440\u0430\u0432\u0438\u043b\u0430"} {" / "}
                  {"\u0417\u0433\u0435\u043d\u0435\u0440\u043e\u0432\u0430\u043d\u043e:"} {new Date(weekAiAdvisor.generatedAt).toLocaleTimeString()}
                </p>
              ) : null}
              {isLightWeek ? (
                <>
                  <p className="assistant-title">{"\u0422\u0438\u0436\u0434\u0435\u043d\u044c \u0432\u0438\u0433\u043b\u044f\u0434\u0430\u0454 \u0432\u0456\u0434\u043d\u043e\u0441\u043d\u043e \u043b\u0435\u0433\u043a\u0438\u043c."}</p>
                  <p className="inbox-meta">{"AI \u043d\u0435 \u0431\u0430\u0447\u0438\u0442\u044c \u044f\u0432\u043d\u043e\u0433\u043e \u043f\u0435\u0440\u0435\u0432\u0430\u043d\u0442\u0430\u0436\u0435\u043d\u043d\u044f. \u042f\u043a\u0449\u043e \u0445\u043e\u0447\u0435\u0448, \u0432\u0438\u043a\u043e\u0440\u0438\u0441\u0442\u0430\u0439 \u0446\u0435\u0439 \u043c\u043e\u043c\u0435\u043d\u0442 \u0434\u043b\u044f \u0440\u0443\u0447\u043d\u043e\u0433\u043e \u0437\u0432\u0456\u0440\u0435\u043d\u043d\u044f \u0431\u0435\u043a\u043b\u043e\u0433\u0443, \u043a\u043e\u043d\u0442\u0435\u043a\u0441\u0442\u0443 \u0430\u0431\u043e \u0442\u0438\u0436\u043d\u0435\u0432\u043e\u0433\u043e \u0444\u043e\u043a\u0443\u0441\u0443."}</p>
                </>
              ) : (
                <>
                  <p className="assistant-title">{normalizePlanningCopy(weekAiAdvisor.advisor.whatMattersMostNow)}</p>
                  <p className="inbox-meta">
                    {"\u0423 \u043f\u043b\u0430\u043d\u0456 \u0442\u0438\u0436\u043d\u044f:"} {weekAiAdvisor.contextSnapshot.plannedTodayCount} {" / "} {"\u0414\u0435\u0434\u043b\u0430\u0439\u043d\u0438 \u0431\u0435\u0437 \u043f\u043b\u0430\u043d\u0443:"} {weekAiAdvisor.contextSnapshot.dueTodayWithoutPlannedStartCount} {" / "} {"\u0411\u0435\u043a\u043b\u043e\u0433:"} {weekAiAdvisor.contextSnapshot.backlogCount}
                  </p>
                  <p className="inbox-meta">
                    {weekLoadCoverageLine({
                      knownMinutes: weekAiAdvisor.contextSnapshot.scheduledKnownEstimateMinutes,
                      missingCount: weekAiAdvisor.contextSnapshot.scheduledMissingEstimateCount,
                      plannedCount: weekAiAdvisor.contextSnapshot.plannedTodayCount
                    })}
                  </p>
                  {weekAiTaskTypeSignals.length > 0 ? (
                    <p className="inbox-meta">{normalizePlanningCopy(weekAiTaskTypeSignals.slice(0, 2).join(" "))}</p>
                  ) : null}
                  <div className="assistant-primary">
                    <p className="assistant-title">{"\u041d\u0430 \u0449\u043e \u043f\u043e\u0434\u0438\u0432\u0438\u0442\u0438\u0441\u044c \u043f\u0435\u0440\u0448\u0438\u043c:"} {weekAiAdvisor.advisor.suggestedNextAction.title}</p>
                    <p className="inbox-meta">{normalizePlanningCopy(weekAiAdvisor.advisor.suggestedNextAction.reason)}</p>
                  </div>
                  <div className="assistant-primary">
                    <p className="assistant-title">{"\u0429\u043e \u043c\u043e\u0436\u043d\u0430 \u0442\u0440\u0438\u043c\u0430\u0442\u0438 \u0433\u043d\u0443\u0447\u043a\u0456\u0448\u0435:"} {weekAiAdvisor.advisor.suggestedDefer.title}</p>
                    <p className="inbox-meta">{normalizePlanningCopy(weekAiAdvisor.advisor.suggestedDefer.reason)}</p>
                  </div>
                  <p className={weekAiAdvisor.advisor.protectedEssentialsWarning.hasWarning ? "error-note" : "inbox-meta"}>
                    {normalizePlanningCopy(weekAiAdvisor.advisor.protectedEssentialsWarning.message)}
                  </p>
                  <p className="inbox-meta">{normalizePlanningCopy(weekAiAdvisor.advisor.explanation)}</p>
                  {weekAiWeekDays.length > 0 ? (
                    <ul className="assistant-secondary">
                      {weekAiWeekDays.map((day) => (
                        <li key={day.scopeDate}>{formatWeekDaySummary(day)}</li>
                      ))}
                    </ul>
                  ) : null}
                </>
              )}
            </section>
          ) : null}
        </section>
      ) : null}
      {!isWeekSurface && !loading ? (
        <>
          {!isSelectedToday ? (
            <section className="today-section">
              <h3>{"\u041f\u0456\u0434\u043a\u0430\u0437\u043a\u0430 \u0434\u043b\u044f \u0432\u0438\u0431\u0440\u0430\u043d\u043e\u0433\u043e \u0434\u043d\u044f"}</h3>
              <p className="inbox-meta">
                {"\u0414\u0435\u0442\u0435\u0440\u043c\u0456\u043d\u043e\u0432\u0430\u043d\u0438\u0439 \u043f\u043b\u0430\u043d \u0434\u043d\u044f \u0456 \u043f\u043e\u0440\u0430\u0434\u0430 AI \u043b\u0438\u0448\u0430\u044e\u0442\u044c\u0441\u044f \u043f\u0440\u0438\u0432\u2019\u044f\u0437\u0430\u043d\u0438\u043c\u0438 \u0434\u043e \u043f\u043e\u0442\u043e\u0447\u043d\u043e\u0433\u043e \u0441\u044c\u043e\u0433\u043e\u0434\u043d\u0456. \u0414\u043b\u044f \u0432\u0438\u0431\u0440\u0430\u043d\u043e\u0457 \u0434\u0430\u0442\u0438 \u043d\u0438\u0436\u0447\u0435 \u043f\u043e\u043a\u0430\u0437\u0430\u043d\u043e \u043f\u0440\u0430\u0432\u0438\u043b\u044c\u043d\u0443 \u0441\u0442\u0440\u0443\u043a\u0442\u0443\u0440\u0443 \u0434\u043d\u044f, \u043a\u0430\u043b\u0435\u043d\u0434\u0430\u0440\u043d\u0438\u0439 \u043a\u043e\u043d\u0442\u0435\u043a\u0441\u0442 \u0456 planning conversation \u0441\u0430\u043c\u0435 \u0434\u043b\u044f "}{selectedDayLabel}.
              </p>
            </section>
          ) : null}
          <section className="today-section block-section">
            <div className="block-section__header">
              <div>
                <h3>{"\u0411\u043b\u043e\u043a\u0438 \u0442\u0430 \u043f\u043e\u0434\u0456\u0457 \u0434\u043d\u044f"}</h3>
                <p className="inbox-meta">Тут видно часові контейнери дня, які можна відкрити й за потреби відредагувати.</p>
              </div>
            </div>
            {!calendarStatus?.connected ? (
              <p className="empty-note">Google Calendar не підключено. Підключи його на вкладці «Календар».</p>
            ) : (
              <>
                {calendarToday.length === 0 ? (
                  <p className="empty-note">{"\u041d\u0430 \u0432\u0438\u0431\u0440\u0430\u043d\u0438\u0439 \u0434\u0435\u043d\u044c \u043f\u043e\u0434\u0456\u0439 \u043d\u0435 \u0437\u043d\u0430\u0439\u0434\u0435\u043d\u043e."}</p>
                ) : (
                  <ul className="inbox-list">
                    {calendarToday.slice(0, 4).map((block) => (
                      <li className="inbox-item block-row" key={block.id}>
                        <p className="inbox-main-text">{block.title}</p>
                        <p className="inbox-meta">{formatCalendarEventTimeRange(block)}</p>
                        <p className="inbox-meta block-row__meta">{block.source === "google" ? "Подія з Google Calendar" : "Блок із додатку"} · Проєкт: {projectNameForCalendarBlock(block)}</p>
                        <div className="inbox-actions">
                          <button type="button" className="ghost" onClick={() => openCalendarBlock(block)} disabled={calendarBlockBusy}>
                            Відкрити
                          </button>
                          {block.provider_event_url ? (
                            <button
                              type="button"
                              className="ghost"
                              onClick={() => {
                                const providerUrl = block.provider_event_url;
                                if (!providerUrl) return;
                                if (window.Telegram?.WebApp?.openLink) {
                                  window.Telegram.WebApp.openLink(providerUrl);
                                  return;
                                }
                                window.open(providerUrl, "_blank", "noopener,noreferrer");
                              }}
                            >
                              Google Calendar
                            </button>
                          ) : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                {nextCalendarEvent ? (
                  <p className="inbox-meta">
                    {"\u041d\u0430\u0441\u0442\u0443\u043f\u043d\u0430 \u043f\u043e\u0434\u0456\u044f \u043f\u0456\u0441\u043b\u044f \u0446\u044c\u043e\u0433\u043e \u0434\u043d\u044f:"} {nextCalendarEvent.title} {" / "} {formatCalendarEventTimeRange(nextCalendarEvent)}
                  </p>
                ) : null}
              </>
            )}
          </section>
          <section className="today-section">
            <h3>{"\u0421\u0442\u0440\u0443\u043a\u0442\u0443\u0440\u0430 \u0432\u0438\u0431\u0440\u0430\u043d\u043e\u0433\u043e \u0434\u043d\u044f"}</h3>
            <p className="inbox-meta">
              {"\u0417\u0430\u043f\u043b\u0430\u043d\u043e\u0432\u0430\u043d\u043e \u043d\u0430 \u0432\u0438\u0431\u0440\u0430\u043d\u0438\u0439 \u0434\u0435\u043d\u044c:"} {scheduledToday.length} {" \u00b7 "} {"\u0414\u0435\u0434\u043b\u0430\u0439\u043d\u0438 \u0446\u044c\u043e\u0433\u043e \u0434\u043d\u044f \u0431\u0435\u0437 \u043f\u043b\u0430\u043d\u0443:"} {dueTodayWithoutSchedule.length} {" \u00b7 "} {"\u0423 \u0431\u0435\u043a\u043b\u043e\u0437\u0456:"} {pureBacklogItems.length}
            </p>
            <p className="inbox-meta">{loadCoverageLine({ knownMinutes: todayKnownEstimateMinutes, missingCount: todayMissingEstimateCount, plannedCount: scheduledToday.length })}</p>
            <p className="inbox-meta">{"\u041f\u043b\u0430\u043d\u0443\u0432\u0430\u043d\u043d\u044f \u0434\u043b\u044f \u0432\u0438\u0431\u0440\u0430\u043d\u043e\u0433\u043e \u0434\u043d\u044f \u0437\u043e\u0441\u0435\u0440\u0435\u0434\u0436\u0435\u043d\u0435 \u043d\u0430 \u0437\u0430\u0434\u0430\u0447\u0430\u0445 \u0456\u0437 \u043f\u043b\u0430\u043d\u043e\u0432\u0430\u043d\u0438\u043c \u0441\u0442\u0430\u0440\u0442\u043e\u043c. \u0411\u0435\u043a\u043b\u043e\u0433 \u043d\u0435 \u043f\u0456\u0434\u0442\u044f\u0433\u0443\u0454\u0442\u044c\u0441\u044f \u0432 \u0434\u0435\u043d\u044c \u0430\u0432\u0442\u043e\u043c\u0430\u0442\u0438\u0447\u043d\u043e."}</p>
          </section>
          {renderSection(isSelectedToday ? "\u0417\u0430\u043f\u043b\u0430\u043d\u043e\u0432\u0430\u043d\u043e \u043d\u0430 \u0441\u044c\u043e\u0433\u043e\u0434\u043d\u0456" : "\u0417\u0430\u043f\u043b\u0430\u043d\u043e\u0432\u0430\u043d\u043e \u043d\u0430 \u0432\u0438\u0431\u0440\u0430\u043d\u0438\u0439 \u0434\u0435\u043d\u044c", "\u041e\u0441\u043d\u043e\u0432\u043d\u0438\u0439 \u0441\u043f\u0438\u0441\u043e\u043a \u0434\u043d\u044f: \u0442\u0456\u043b\u044c\u043a\u0438 \u0437\u0430\u0434\u0430\u0447\u0456 \u0437 \u043f\u043b\u0430\u043d\u043e\u0432\u0430\u043d\u0438\u043c \u0441\u0442\u0430\u0440\u0442\u043e\u043c \u043d\u0430 \u0446\u044e \u0434\u0430\u0442\u0443.", scheduledToday, "scheduled")}
          {renderSection(isSelectedToday ? "Заплановане раніше" : "Заплановане до цієї дати", isSelectedToday ? "Тут задачі, які вже мали стартувати раніше й досі лишаються відкритими." : "Тут задачі, які мали стартувати ще до цієї дати й досі лишаються відкритими.", overdueScheduled, "neutral")}
          {renderSection(isSelectedToday ? "\u0414\u0435\u0434\u043b\u0430\u0439\u043d\u0438 \u0441\u044c\u043e\u0433\u043e\u0434\u043d\u0456 \u0431\u0435\u0437 \u043f\u043b\u0430\u043d\u0443" : "\u0414\u0435\u0434\u043b\u0430\u0439\u043d\u0438 \u0446\u044c\u043e\u0433\u043e \u0434\u043d\u044f \u0431\u0435\u0437 \u043f\u043b\u0430\u043d\u0443", "\u041e\u043a\u0440\u0435\u043c\u043e \u043f\u043e\u043a\u0430\u0437\u0430\u043d\u0456 \u0437\u0430\u0434\u0430\u0447\u0456 \u0437 \u0434\u0435\u0434\u043b\u0430\u0439\u043d\u043e\u043c \u043d\u0430 \u0432\u0438\u0431\u0440\u0430\u043d\u0438\u0439 \u0434\u0435\u043d\u044c, \u0430\u043b\u0435 \u0431\u0435\u0437 \u043f\u043b\u0430\u043d\u043e\u0432\u0430\u043d\u043e\u0433\u043e \u0441\u0442\u0430\u0440\u0442\u0443.", dueTodayWithoutSchedule, "unscheduled")}
          {renderSection("\u0411\u0435\u043a\u043b\u043e\u0433", isSelectedToday ? "\u0422\u0443\u0442 \u0437\u0430\u0434\u0430\u0447\u0456 \u0431\u0435\u0437 \u043f\u043b\u0430\u043d\u043e\u0432\u0430\u043d\u043e\u0433\u043e \u0441\u0442\u0430\u0440\u0442\u0443. \u0417\u0432\u0456\u0434\u0441\u0438 \u0457\u0445 \u043c\u043e\u0436\u043d\u0430 \u0448\u0432\u0438\u0434\u043a\u043e \u043f\u043e\u0441\u0442\u0430\u0432\u0438\u0442\u0438 \u0432 \u043f\u043b\u0430\u043d \u0434\u043d\u044f." : "\u0422\u0443\u0442 \u0437\u0430\u0434\u0430\u0447\u0456 \u0431\u0435\u0437 \u043f\u043b\u0430\u043d\u043e\u0432\u0430\u043d\u043e\u0433\u043e \u0441\u0442\u0430\u0440\u0442\u0443. \u0417\u0432\u0456\u0434\u0441\u0438 \u0457\u0445 \u043c\u043e\u0436\u043d\u0430 \u0448\u0432\u0438\u0434\u043a\u043e \u043f\u043e\u0441\u0442\u0430\u0432\u0438\u0442\u0438 \u0432 \u043f\u043b\u0430\u043d \u043d\u0430 \u0432\u0438\u0431\u0440\u0430\u043d\u0438\u0439 \u0434\u0435\u043d\u044c.", pureBacklogItems, "unscheduled")}
          {renderSection("Захищені / регулярні важливі", "Огляд важливих регулярних і захищених задач без автопланування.", protectedEssentials, "neutral")}
        </>
      ) : null}

      <CalendarEventModal
        open={calendarBlockCreateOpen || !!activeCalendarBlock}
        titleHint={activeCalendarBlock?.title ?? ""}
        detailsHint={activeCalendarBlock?.details ?? ""}
        startHint={activeCalendarBlock?.start_at ?? new Date().toISOString()}
        endHint={activeCalendarBlock?.end_at ?? new Date(Date.now() + 60 * 60 * 1000).toISOString()}
        projectIdHint={activeCalendarBlock?.project_id ?? null}
        projectOptions={projects}
        heading={activeCalendarBlock ? "Редагування блоку" : "Новий блок"}
        subtitle={
          activeCalendarBlock
            ? activeCalendarBlock.source === "google"
              ? "Подія прийшла з Google Calendar, але її можна спокійно змінити тут."
              : "Блок створено в додатку й синхронізовано з Google Calendar."
            : "Новий блок одразу збережеться в календарі й з'явиться в планувальних surfaces."
        }
        confirmLabel={activeCalendarBlock ? "Зберегти зміни" : "Створити блок"}
        deleteLabel="Видалити блок"
        readOnlyReason={activeCalendarBlock?.is_all_day ? "Події на весь день поки що можна редагувати тільки в Google Calendar." : null}
        busy={calendarBlockBusy}
        errorMessage={calendarBlockError}
        onCancel={() => {
          if (calendarBlockBusy) return;
          setActiveCalendarBlock(null);
          setCalendarBlockError(null);
        }}
        onDelete={activeCalendarBlock ? () => void deleteActiveCalendarBlock() : undefined}
        onConfirm={(payload) => {
          void saveCalendarBlock(payload);
        }}
      />

      <TaskDetailModal
        open={taskModalMode === "create" || !!activeTask}
        task={activeTask}
        projects={projects}
        busy={workingTaskId !== null}
        calendarSyncNotice={activeTask ? calendarNotice : null}
        calendarInboundState={activeTask ? calendarInboundState : null}
        initialMode={taskModalMode === "create" ? "create" : "edit"}
        createDefaults={todayTaskCreateDefaults}
        showWorkflowActions={false}
        onClose={() => {
          setActiveTask(null);
          setTaskModalMode("edit");
        }}
        onSave={(payload) => {
          void (async () => {
            if (taskModalMode === "create") {
              const created = await createTaskFromToday({
                title: payload.title,
                details: payload.details,
                projectId: payload.projectId,
                taskType: payload.taskType,
                dueAt: payload.dueAt,
                scheduledFor: payload.scheduledFor,
                estimatedMinutes: payload.estimatedMinutes,
                planningFlexibility: payload.planningFlexibility
              });
              if (created) {
                setActiveTask(null);
                setTaskModalMode("edit");
              }
              return;
            }

            if (!activeTask) return;
            const saved = await saveTaskUpdate(activeTask, {
              title: payload.title,
              details: payload.details,
              projectId: payload.projectId,
              taskType: payload.taskType,
              dueAt: payload.dueAt,
              scheduledFor: payload.scheduledFor,
              estimatedMinutes: payload.estimatedMinutes,
              planningFlexibility: payload.planningFlexibility
            });
            if (saved) setActiveTask(null);
          })();
        }}
        onAction={() => {}}
        onCreateCalendarEvent={() => {}}
        onRetryCalendarSync={() => {
          if (!activeTask) return;
          void retryActiveTaskCalendarSync(activeTask);
        }}
        onDetachCalendarLink={() => {
          if (!activeTask) return;
          void detachActiveTaskCalendarLink(activeTask);
        }}
        onApplyCalendarInbound={() => {
          if (!activeTask) return;
          void applyInboundCalendarChange(activeTask);
        }}
        onKeepCalendarAppVersion={() => {
          if (!activeTask) return;
          void keepCalendarAppVersion(activeTask);
        }}
        onOpenLinkedCalendarEvent={() => {}}
      />

      <NoteDetailModal
        open={noteCreateOpen}
        mode="create"
        note={null}
        projects={projects}
        busy={noteCreating}
        onClose={() => setNoteCreateOpen(false)}
        onSave={(payload) => {
          void (async () => {
            const created = await createNoteFromToday({
              title: payload.title,
              body: payload.body,
              projectId: payload.projectId
            });
            if (created) setNoteCreateOpen(false);
          })();
        }}
      />
      <PlanningConversationModal
        open={planningConversationOpen}
        scopeType={planningConversation?.session.scopeType ?? planningConversationScopeType}
        scopeDate={planningConversation?.session.scopeDate ?? (planningConversationScopeType === "week" ? selectedWeekScopeDate : selectedScopeDate)}
        state={planningConversation}
        busy={planningConversationBusy}
        actingProposalId={actingProposalId}
        errorMessage={planningConversationError}
        onClose={() => {
          setPlanningConversationOpen(false);
          setPlanningConversationError(null);
        }}
        onRetryLoad={() => {
          void openPlanningConversation(planningConversation?.session.scopeType ?? planningConversationScopeType);
        }}
        onSend={(message) => {
          void sendPlanningMessage(message);
        }}
        onTranscribeVoice={(file) => transcribePlanningConversationVoice(file)}
        onApplyProposal={(proposalId) => {
          void actOnProposal(proposalId, "apply");
        }}
        onDismissProposal={(proposalId) => {
          void actOnProposal(proposalId, "dismiss");
        }}
        onApplyAllLatest={(assistantMessageId) => {
          if (assistantMessageId !== planningConversation?.latestActionableAssistantMessageId) return;
          void actOnLatestProposalSet("apply_all_latest");
        }}
        onDismissAllLatest={(assistantMessageId) => {
          if (assistantMessageId !== planningConversation?.latestActionableAssistantMessageId) return;
          void actOnLatestProposalSet("dismiss_all_latest");
        }}
      />
    </section>
  );
}





















































