import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CalendarEventModal } from "../../components/CalendarEventModal";
import { NoteDetailModal } from "../../components/NoteDetailModal";
import { PlanningConversationModal } from "../../components/PlanningConversationModal";
import { TaskDetailModal } from "../../components/TaskDetailModal";
import { useDiagnostics } from "../../lib/diagnostics";
import { recurrenceLabel } from "../../lib/recurrence";
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
  applyTaskGoogleInbound,
  createNote,
  createTask,
  deleteCalendarBlock,
  deleteTask,
  detachTaskCalendarLink as detachTaskCalendarLinkRequest,
  detachTaskGoogleLink as detachTaskGoogleLinkRequest,
  getAiAdvisor,
  getCalendarBlocks,
  getGoogleCalendarStatus,
  inspectTaskCalendarInbound,
  inspectTaskGoogleInbound,
  keepTaskCalendarLocalVersion,
  getPlanningAssistant,
  getPlanningConversation,
  getProjects,
  getTasks,
  retryTaskCalendarSync as retryTaskCalendarSyncRequest,
  retryTaskGoogleSync as retryTaskGoogleSyncRequest,
  startGoogleCalendarConnect,
  sendPlanningConversationTurn,
  transcribePlanningVoice,
  updatePlanningProposal,
  updateTask,
  updateTaskStatus,
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
  TaskGoogleInboundState,
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

function parseDateOrNull(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatTimeOfDay(value: Date): string {
  return new Intl.DateTimeFormat("uk-UA", { hour: "2-digit", minute: "2-digit" }).format(value);
}

function toLocalDateTimeInput(value: string | null | undefined): string {
  const parsed = parseDateOrNull(value);
  if (!parsed) return "";
  const offsetMs = parsed.getTimezoneOffset() * 60_000;
  const localDate = new Date(parsed.getTime() - offsetMs);
  return localDate.toISOString().slice(0, 16);
}

function formatBlockTimelineRange(block: CalendarBlockItem): string {
  if (block.is_all_day) return "Увесь день";
  const start = parseDateOrNull(block.start_at);
  if (!start) return "Без часу";
  const end = parseDateOrNull(block.end_at);
  if (!end) return formatTimeOfDay(start);
  return `${formatTimeOfDay(start)} - ${formatTimeOfDay(end)}`;
}

function formatTaskTimelineRange(task: TaskItem): string {
  const start = parseDateOrNull(task.scheduled_for);
  if (!start) return formatTaskTimingSummary(task);
  if (task.estimated_minutes && task.estimated_minutes > 0) {
    const end = new Date(start.getTime() + task.estimated_minutes * 60_000);
    return `${formatTimeOfDay(start)} - ${formatTimeOfDay(end)}`;
  }
  return formatTimeOfDay(start);
}

function taskTimelineMeta(task: TaskItem): string {
  const parts = [taskTypeLabel(task.task_type), projectName(task)];
  if (task.planning_flexibility) parts.push(planningFlexibilityLabel(task.planning_flexibility));
  return parts.join(" · ");
}

function recurringShortHint(rule: string | null | undefined): string | null {
  const label = recurrenceLabel(rule);
  return label ? `Повтор: ${label}` : null;
}

type DayTimelineEntry =
  | { kind: "block"; sortTime: number; block: CalendarBlockItem; tasks: TaskItem[] }
  | { kind: "task"; sortTime: number; task: TaskItem };

type BlockTimelineLayout = {
  block: CalendarBlockItem;
  tasks: TaskItem[];
  top: number;
  height: number;
  lane: number;
  laneCount: number;
  start: Date;
  end: Date;
};

type StandaloneTaskLayout = {
  task: TaskItem;
  top: number;
  height: number;
  start: Date;
  end: Date;
  left: string;
  width: string;
  nested: boolean;
  parentBlockId: string | null;
  preservesBlockHeader: boolean;
  collisionGroupKey: string | null;
  collisionLane: number;
  collisionLaneCount: number;
};

const TIMELINE_PX_PER_MINUTE = 1.6;
const TIMELINE_BLOCK_MIN_HEIGHT = 72;
const TIMELINE_TASK_MIN_HEIGHT = 44;
const TIMELINE_NESTED_TASK_MIN_HEIGHT = 40;
const TIMELINE_BLOCK_HEADER_HEIGHT = 38;
const TIMELINE_BLOCK_HEADER_PROTECT_PX = 68;
const TIMELINE_MIN_LANE_WIDTH = 220;
const TIMELINE_CANVAS_MIN_WIDTH = 320;
const TIMELINE_LANE_GAP_PX = 8;

function minutesBetween(start: Date, end: Date): number {
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 60_000));
}

function roundTimelineStart(value: Date): Date {
  const rounded = new Date(value);
  rounded.setMinutes(0, 0, 0);
  rounded.setHours(rounded.getHours() - 1);
  return rounded;
}

function roundTimelineEnd(value: Date): Date {
  const rounded = new Date(value);
  rounded.setMinutes(0, 0, 0);
  rounded.setHours(rounded.getHours() + 2);
  return rounded;
}

function timelineHeight(minutes: number, minHeight: number): number {
  return Math.max(minHeight, Math.round(minutes * TIMELINE_PX_PER_MINUTE));
}

function timelineOffset(windowStart: Date, value: Date): number {
  return Math.max(0, Math.round(minutesBetween(windowStart, value) * TIMELINE_PX_PER_MINUTE));
}

function timelineDurationHeight(minutes: number, minHeight: number): number {
  return timelineHeight(Math.max(15, minutes), minHeight);
}

function timelineLaneStyle(lane: number, laneCount: number, insetPx = 0): { left: string; width: string } {
  const totalGap = Math.max(0, laneCount - 1) * TIMELINE_LANE_GAP_PX;
  const width = `calc((100% - ${totalGap}px) / ${laneCount} - ${insetPx}px)`;
  const left = `calc(${(100 / laneCount) * lane}% + ${lane * TIMELINE_LANE_GAP_PX}px + ${insetPx}px)`;
  return { left, width };
}

function timelineTaskCollisionStyle(lane: number, laneCount: number): { left: string; width: string } {
  if (laneCount <= 1) return { left: "0%", width: "100%" };

  const stepPercent = laneCount === 2 ? 26 : laneCount === 3 ? 18 : 14;
  const totalInsetPercent = Math.max(0, laneCount - 1) * stepPercent;

  return {
    left: `${lane * stepPercent}%`,
    width: `calc(100% - ${totalInsetPercent}%)`
  };
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

function oauthReasonLabel(reason: string | null): string {
  if (!reason) return "Google успішно підключено.";
  if (reason === "invalid_or_expired_state") return "Спроба підключення застаріла. Запусти її ще раз.";
  if (reason === "missing_code_or_state") return "Google не повернув потрібні дані для підключення.";
  if (reason === "google_oauth_callback_failed") return "Не вдалося завершити підключення Google.";
  if (reason.startsWith("oauth_")) return "Google повернув помилку під час підключення.";
  return "Підключення Google не вдалося.";
}

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
  const [calendarBlockModalMode, setCalendarBlockModalMode] = useState<"view" | "edit" | "create">("view");
  const [calendarBlockBusy, setCalendarBlockBusy] = useState(false);
  const [calendarBlockError, setCalendarBlockError] = useState<string | null>(null);
  const [activeTask, setActiveTask] = useState<TaskItem | null>(null);
  const [taskModalMode, setTaskModalMode] = useState<"view" | "edit" | "create">("view");
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
  const [googleTaskNotice, setGoogleTaskNotice] = useState<CalendarNotice | null>(null);
  const [googleTaskInboundState, setGoogleTaskInboundState] = useState<TaskGoogleInboundState | null>(null);
  const [pageNotice, setPageNotice] = useState<CalendarNotice | null>(null);
  const diagnostics = useDiagnostics();
  const navigate = useNavigate();

  const sessionToken = localStorage.getItem(SESSION_KEY) ?? "";
  const connectHint = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    const marker = params.get("calendar_connect");
    const reason = params.get("reason");
    if (marker === "success") return { tone: "success" as const, message: "Google перепідключено. Оновлюю стан синхронізації..." };
    if (marker === "error") return { tone: "error" as const, message: oauthReasonLabel(reason) };
    return null;
  }, []);

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
    if (!connectHint) return;
    if (connectHint.tone === "success" && sessionToken) {
      void (async () => {
        await loadToday();
        try {
          const status = await getGoogleCalendarStatus(sessionToken);
          setPageNotice(
            status.tasksScopeAvailable
              ? { tone: "success", message: "Google перепідключено. Google Tasks уже доступні." }
              : { tone: "info", message: "Google перепідключено, але Google Tasks досі недоступні для цього акаунта." }
          );
        } catch {
          setPageNotice(connectHint);
        }
      })();
    } else {
      setPageNotice(connectHint);
    }
    const url = new URL(window.location.href);
    url.searchParams.delete("calendar_connect");
    url.searchParams.delete("reason");
    window.history.replaceState({}, "", url.toString());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectHint, sessionToken]);

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

  useEffect(() => {
    if (!sessionToken || !activeTask || activeTask.google_task_sync_mode !== "app_managed" || !activeTask.google_task_id) {
      setGoogleTaskInboundState(null);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const state = await inspectTaskGoogleInbound({ sessionToken, taskId: activeTask.id });
        if (!cancelled) setGoogleTaskInboundState(state);
      } catch {
        if (!cancelled) setGoogleTaskInboundState(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeTask?.id, activeTask?.google_task_id, activeTask?.google_task_sync_mode, sessionToken]);

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

  const dayTimeline = useMemo<DayTimelineEntry[]>(() => {
    const sortedBlocks = [...calendarToday].sort((left, right) => {
      const leftStart = parseDateOrNull(left.start_at)?.getTime() ?? Number.MAX_SAFE_INTEGER;
      const rightStart = parseDateOrNull(right.start_at)?.getTime() ?? Number.MAX_SAFE_INTEGER;
      return leftStart - rightStart;
    });

    const tasksByBlock = new Map<string, TaskItem[]>();
    const standaloneTasks: TaskItem[] = [];

    for (const task of scheduledToday) {
      const scheduledAt = parseDateOrNull(task.scheduled_for);
      if (!scheduledAt) {
        standaloneTasks.push(task);
        continue;
      }

      const matchingBlock = sortedBlocks.find((block) => {
        if (block.is_all_day) return false;
        const blockStart = parseDateOrNull(block.start_at);
        const blockEnd = parseDateOrNull(block.end_at);
        if (!blockStart || !blockEnd) return false;
        return scheduledAt.getTime() >= blockStart.getTime() && scheduledAt.getTime() < blockEnd.getTime();
      });

      if (!matchingBlock) {
        standaloneTasks.push(task);
        continue;
      }

      const existing = tasksByBlock.get(matchingBlock.id) ?? [];
      existing.push(task);
      tasksByBlock.set(matchingBlock.id, existing);
    }

    const entries: DayTimelineEntry[] = [
      ...sortedBlocks.map((block) => ({
        kind: "block" as const,
        sortTime: parseDateOrNull(block.start_at)?.getTime() ?? Number.MAX_SAFE_INTEGER,
        block,
        tasks: sortTasksByTimeField(tasksByBlock.get(block.id) ?? [], "scheduled_for")
      })),
      ...standaloneTasks.map((task) => ({
        kind: "task" as const,
        sortTime: parseDateOrNull(task.scheduled_for)?.getTime() ?? Number.MAX_SAFE_INTEGER,
        task
      }))
    ];

    return entries.sort((left, right) => left.sortTime - right.sortTime);
  }, [calendarToday, scheduledToday]);

  const visibleDayWindow = useMemo(() => {
    const points: Date[] = [];

    for (const block of calendarToday) {
      const start = parseDateOrNull(block.start_at);
      const end = parseDateOrNull(block.end_at);
      if (start) points.push(start);
      if (end) points.push(end);
    }

    for (const task of scheduledToday) {
      const start = parseDateOrNull(task.scheduled_for);
      if (!start) continue;
      points.push(start);
      const end = task.estimated_minutes && task.estimated_minutes > 0
        ? new Date(start.getTime() + task.estimated_minutes * 60_000)
        : new Date(start.getTime() + 30 * 60_000);
      points.push(end);
    }

    if (points.length === 0) return null;

    const sorted = points.sort((left, right) => left.getTime() - right.getTime());
    return {
      start: roundTimelineStart(sorted[0]!),
      end: roundTimelineEnd(sorted[sorted.length - 1]!)
    };
  }, [calendarToday, scheduledToday]);

  const hourMarks = useMemo(() => {
    if (!visibleDayWindow) return [];
    const marks: Array<{ label: string; top: number }> = [];
    const cursor = new Date(visibleDayWindow.start);
    cursor.setMinutes(0, 0, 0);
    while (cursor.getTime() <= visibleDayWindow.end.getTime()) {
      marks.push({
        label: formatTimeOfDay(cursor),
        top: timelineOffset(visibleDayWindow.start, cursor)
      });
      cursor.setHours(cursor.getHours() + 1);
    }
    return marks;
  }, [visibleDayWindow]);

  const blockTimelineLayouts = useMemo<BlockTimelineLayout[]>(() => {
    if (!visibleDayWindow) return [];

    const sortedBlocks = [...calendarToday]
      .map((block) => {
        const start = parseDateOrNull(block.start_at);
        const end = parseDateOrNull(block.end_at);
        if (!start || !end || block.is_all_day) return null;
        return { block, start, end };
      })
      .filter((item): item is { block: CalendarBlockItem; start: Date; end: Date } => Boolean(item))
      .sort((left, right) => left.start.getTime() - right.start.getTime());

    const tasksByBlock = new Map<string, TaskItem[]>();
    for (const task of scheduledToday) {
      const scheduledAt = parseDateOrNull(task.scheduled_for);
      if (!scheduledAt) continue;
      const matchingBlock = sortedBlocks.find((item) => scheduledAt >= item.start && scheduledAt < item.end);
      if (!matchingBlock) continue;
      const existing = tasksByBlock.get(matchingBlock.block.id) ?? [];
      existing.push(task);
      tasksByBlock.set(matchingBlock.block.id, sortTasksByTimeField(existing, "scheduled_for"));
    }

    const assignments: Array<{
      block: CalendarBlockItem;
      tasks: TaskItem[];
      start: Date;
      end: Date;
      lane: number;
      laneCount: number;
    }> = [];
    let active: Array<{ end: number; lane: number; index: number }> = [];
    let clusterIndices: number[] = [];
    let clusterMaxLane = 0;

    const finalizeCluster = () => {
      if (clusterIndices.length === 0) return;
      for (const index of clusterIndices) assignments[index]!.laneCount = clusterMaxLane || 1;
      clusterIndices = [];
      clusterMaxLane = 0;
    };

    for (const item of sortedBlocks) {
      active = active.filter((entry) => entry.end > item.start.getTime());
      if (active.length === 0) finalizeCluster();

      const usedLanes = new Set(active.map((entry) => entry.lane));
      let lane = 0;
      while (usedLanes.has(lane)) lane += 1;

      const index = assignments.push({
        block: item.block,
        tasks: tasksByBlock.get(item.block.id) ?? [],
        start: item.start,
        end: item.end,
        lane,
        laneCount: 1
      }) - 1;

      active.push({ end: item.end.getTime(), lane, index });
      clusterIndices.push(index);
      clusterMaxLane = Math.max(clusterMaxLane, active.length);
    }
    finalizeCluster();

    return assignments.map((entry) => ({
      ...entry,
      top: timelineOffset(visibleDayWindow.start, entry.start),
      height: timelineDurationHeight(minutesBetween(entry.start, entry.end), TIMELINE_BLOCK_MIN_HEIGHT)
    }));
  }, [calendarToday, scheduledToday, visibleDayWindow]);

  const scheduledTaskLayouts = useMemo<StandaloneTaskLayout[]>(() => {
    if (!visibleDayWindow) return [];

    const baseLayouts: StandaloneTaskLayout[] = scheduledToday
      .map((task) => {
        const start = parseDateOrNull(task.scheduled_for)!;
        const end = new Date(start.getTime() + ((task.estimated_minutes && task.estimated_minutes > 0 ? task.estimated_minutes : 30) * 60_000));
        const parentBlock = blockTimelineLayouts.find((entry) => start >= entry.start && start < entry.end);
        const headerOverlapPx = parentBlock ? timelineOffset(parentBlock.start, start) : 0;
        const preservesBlockHeader = Boolean(parentBlock && headerOverlapPx < TIMELINE_BLOCK_HEADER_PROTECT_PX);
        const overlayInsetPx = preservesBlockHeader ? (parentBlock?.laneCount && parentBlock.laneCount > 1 ? 44 : 72) : parentBlock ? 8 : 0;
        const laneStyle = parentBlock
          ? timelineLaneStyle(parentBlock.lane, parentBlock.laneCount, overlayInsetPx)
          : { left: "0px", width: "100%" };
        return {
          task,
          start,
          end,
          top: timelineOffset(visibleDayWindow.start, start),
          height: timelineDurationHeight(
            minutesBetween(start, end),
            parentBlock ? TIMELINE_NESTED_TASK_MIN_HEIGHT : TIMELINE_TASK_MIN_HEIGHT
          ),
          left: laneStyle.left,
          width: laneStyle.width,
          nested: Boolean(parentBlock),
          parentBlockId: parentBlock?.block.id ?? null,
          preservesBlockHeader,
          collisionGroupKey: null,
          collisionLane: 0,
          collisionLaneCount: 1
        };
      });

    const groupedLayouts = new Map<string, number[]>();
    baseLayouts.forEach((entry, index) => {
      if (!entry.nested || !entry.parentBlockId) return;
      const group = groupedLayouts.get(entry.parentBlockId) ?? [];
      group.push(index);
      groupedLayouts.set(entry.parentBlockId, group);
    });

    for (const [blockId, indices] of groupedLayouts.entries()) {
      if (indices.length <= 1) continue;
      const ordered = [...indices].sort((leftIndex, rightIndex) => {
        const left = baseLayouts[leftIndex];
        const right = baseLayouts[rightIndex];
        if (!left || !right) return 0;
        return left.start.getTime() - right.start.getTime() || left.end.getTime() - right.end.getTime();
      });

      let clusterSequence = 0;
      let active: Array<{ end: number; lane: number; index: number }> = [];
      let clusterIndices: number[] = [];
      let clusterMaxLane = 1;

      const finalizeCluster = () => {
        if (clusterIndices.length === 0) return;
        const laneCount = Math.max(1, clusterMaxLane);
        clusterIndices.forEach((layoutIndex) => {
          const current = baseLayouts[layoutIndex];
          if (!current) return;
          baseLayouts[layoutIndex] = {
            ...current,
            collisionGroupKey: `${blockId}:${clusterSequence}`,
            collisionLaneCount: laneCount
          };
        });
        clusterSequence += 1;
        clusterIndices = [];
        clusterMaxLane = 1;
      };

      for (const layoutIndex of ordered) {
        const current = baseLayouts[layoutIndex];
        if (!current) continue;

        active = active.filter((entry) => entry.end > current.start.getTime());
        if (active.length === 0) finalizeCluster();

        const usedLanes = new Set(active.map((entry) => entry.lane));
        let lane = 0;
        while (usedLanes.has(lane)) lane += 1;

        baseLayouts[layoutIndex] = {
          ...current,
          collisionLane: lane
        };

        active.push({
          end: current.end.getTime(),
          lane,
          index: layoutIndex
        });
        clusterIndices.push(layoutIndex);
        clusterMaxLane = Math.max(clusterMaxLane, active.length);
      }

      finalizeCluster();
    }

    return baseLayouts;
  }, [blockTimelineLayouts, scheduledToday, visibleDayWindow]);

  const taskCollisionGroups = useMemo(() => {
    const groups = new Map<
      string,
      { key: string; top: number; height: number; left: string; width: string; entries: StandaloneTaskLayout[] }
    >();

    scheduledTaskLayouts.forEach((entry) => {
      if (!entry.collisionGroupKey || entry.collisionLaneCount <= 1) return;
      const existing = groups.get(entry.collisionGroupKey);
      if (existing) {
        existing.entries.push(entry);
        existing.top = Math.min(existing.top, entry.top);
        existing.height = Math.max(existing.height, entry.top + entry.height);
        return;
      }
      groups.set(entry.collisionGroupKey, {
        key: entry.collisionGroupKey,
        top: entry.top,
        height: entry.top + entry.height,
        left: entry.left,
        width: entry.width,
        entries: [entry]
      });
    });

    return Array.from(groups.values()).map((group) => ({
      ...group,
      height: Math.max(0, group.height - group.top),
      entries: [...group.entries].sort(
        (a, b) => a.collisionLane - b.collisionLane || a.start.getTime() - b.start.getTime() || a.end.getTime() - b.end.getTime()
      )
    }));
  }, [scheduledTaskLayouts]);

  const timelineCanvasHeight = useMemo(() => {
    if (!visibleDayWindow) return 0;
    return timelineDurationHeight(minutesBetween(visibleDayWindow.start, visibleDayWindow.end), 320);
  }, [visibleDayWindow]);

  const timelineCanvasMinWidth = useMemo(() => {
    const maxLaneCount = blockTimelineLayouts.reduce((max, entry) => Math.max(max, entry.laneCount), 1);
    return Math.max(TIMELINE_CANVAS_MIN_WIDTH, maxLaneCount * TIMELINE_MIN_LANE_WIDTH);
  }, [blockTimelineLayouts]);

  const currentTimeOffset = useMemo(() => {
    if (!isSelectedToday || !visibleDayWindow) return null;
    const now = new Date();
    if (now < visibleDayWindow.start || now > visibleDayWindow.end) return null;
    return timelineOffset(visibleDayWindow.start, now);
  }, [isSelectedToday, visibleDayWindow]);

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
    recurrenceFrequency: "daily" | "weekly" | "monthly" | null;
  }): Promise<boolean> {
    if (!sessionToken) {
      setError("Спочатку авторизуйся в Інбоксі.");
      return false;
    }

    setWorkingTaskId("today_create_task");
    setError(null);
    setPageNotice(null);
    diagnostics.trackAction("create_task_from_today", { scopeDate: selectedScopeDate });

    try {
      const created = await createTask({
        sessionToken,
        title: payload.title,
        details: payload.details,
        projectId: payload.projectId,
        taskType: payload.taskType,
        dueAt: payload.dueAt,
        scheduledFor: payload.scheduledFor,
        estimatedMinutes: payload.estimatedMinutes,
        planningFlexibility: payload.planningFlexibility,
        recurrenceFrequency: payload.recurrenceFrequency
      });
      await loadToday();

      const scheduledForSelectedDay =
        payload.scheduledFor && isScheduledForDay({ scheduled_for: payload.scheduledFor } as TaskItem, selectedDayStart, selectedDayEnd);

      if (created.googleTaskSyncError) {
        setPageNotice({
          tone: "info",
          message:
            created.googleTaskSyncError === "google_tasks_scope_missing"
              ? "Задачу створено в додатку, але Google Tasks ще недоступні для цього підключення. Перепідключи Google у вкладці «Календар»."
              : created.googleTaskSyncError === "google_tasks_permission_denied"
                ? "Задачу створено в додатку, але Google Tasks зараз не дає доступ. Перепідключи Google і перевір дозволи для Tasks."
              : "Задачу створено в додатку, але синхронізація з Google Tasks зараз недоступна."
        });
      } else if (!scheduledForSelectedDay) {
        setPageNotice({
          tone: "info",
          message: "Задачу створено в додатку. Вона не належить до цього дня, тому шукай її у вкладці «Задачі»."
        });
      }
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
    recurrenceFrequency?: "daily" | "weekly" | "monthly" | null;
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
          patch.planningFlexibility !== undefined ? patch.planningFlexibility : task.planning_flexibility ?? null,
        recurrenceFrequency:
          patch.recurrenceFrequency !== undefined
            ? patch.recurrenceFrequency
            : task.recurrence_rule?.includes("FREQ=DAILY")
              ? "daily"
              : task.recurrence_rule?.includes("FREQ=WEEKLY")
                ? "weekly"
                : task.recurrence_rule?.includes("FREQ=MONTHLY")
                  ? "monthly"
                  : null
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

  async function deleteCurrentTask() {
    if (!sessionToken || !activeTask) return;

    const recurrenceWarning = activeTask.recurrence_rule ? " Це видалить лише цей повтор." : "";
    const googleTaskWarning = activeTask.linked_google_task
      ? activeTask.google_task_sync_mode === "app_managed"
        ? " Зв'язану задачу в Google Tasks теж буде видалено."
        : " Зв'язок з Google Tasks буде прибрано лише локально."
      : "";
    const confirmed = window.confirm(`Видалити задачу "${activeTask.title}"?${recurrenceWarning}${googleTaskWarning}`);
    if (!confirmed) return;

    setWorkingTaskId(activeTask.id);
    setError(null);
    diagnostics.trackAction("delete_task_from_today", { taskId: activeTask.id, route: "/today" });

    try {
      await deleteTask({ sessionToken, taskId: activeTask.id });
      setActiveTask(null);
      setTaskModalMode("view");
      await loadToday();
    } catch (actionError) {
      if (actionError instanceof ApiError) {
        diagnostics.trackFailure({
          path: actionError.path,
          status: actionError.status,
          code: actionError.code,
          message: actionError.message,
          details: actionError.details
        });
      }
      setError(actionError instanceof Error ? actionError.message : "Не вдалося видалити задачу.");
    } finally {
      setWorkingTaskId(null);
    }
  }

  async function runTaskWorkflowAction(task: TaskItem, action: "done" | "reschedule" | "block" | "unblock" | "cancel") {
    if (!sessionToken) {
      setError("Спочатку авторизуйся в Інбоксі.");
      return;
    }

    if (action === "done") {
      await markTaskDone(task);
      return;
    }

    const common = {
      sessionToken,
      taskId: task.id,
      reasonCode: "other" as const
    };

    setWorkingTaskId(task.id);
    setError(null);
    diagnostics.trackAction("task_workflow_action_from_today", { taskId: task.id, action, route: "/today" });

    try {
      if (action === "reschedule") {
        const suggested = task.scheduled_for
          ? toLocalDateTimeInput(task.scheduled_for)
          : toLocalDateTimeInput(todayTaskCreateDefaults.scheduledFor ?? null);
        const nextStart = window.prompt("Новий час старту для задачі", suggested);
        if (!nextStart) return;
        await updateTaskStatus({
          ...common,
          status: "planned",
          rescheduleTo: nextStart
        });
      }

      if (action === "block") {
        await updateTaskStatus({
          ...common,
          status: "blocked"
        });
      }

      if (action === "unblock") {
        await updateTaskStatus({
          ...common,
          status: "planned"
        });
      }

      if (action === "cancel") {
        const confirmed = window.confirm(task.recurrence_rule ? "Скасувати лише цей повтор?" : "Скасувати задачу?");
        if (!confirmed) return;
        await updateTaskStatus({
          ...common,
          status: "cancelled"
        });
      }

      setActiveTask(null);
      setTaskModalMode("view");
      await loadToday();
    } catch (actionError) {
      if (actionError instanceof ApiError) {
        diagnostics.trackFailure({
          path: actionError.path,
          status: actionError.status,
          code: actionError.code,
          message: actionError.message,
          details: actionError.details
        });
      }
      setError(actionError instanceof Error ? actionError.message : "Не вдалося оновити задачу.");
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
    setCalendarBlockModalMode("view");
    setActiveCalendarBlock(block);
    setCalendarBlockError(null);
  }

  function startCreateCalendarBlock() {
    setActiveCalendarBlock(null);
    setCalendarBlockCreateOpen(true);
    setCalendarBlockModalMode("create");
    setCalendarBlockError(null);
  }

  function openTaskDetails(task: TaskItem) {
    setTaskModalMode("view");
    setActiveTask(task);
    setError(null);
  }

  async function markTaskDone(task: TaskItem) {
    if (!sessionToken) {
      setError("Спочатку авторизуйся в Інбоксі.");
      return;
    }

    setWorkingTaskId(task.id);
    setError(null);
    diagnostics.trackAction("complete_task_from_today_timeline", { taskId: task.id, route: "/today" });

    try {
      await updateTaskStatus({
        sessionToken,
        taskId: task.id,
        status: "done"
      });
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
      setError(saveError instanceof Error ? saveError.message : "Не вдалося позначити задачу виконаною.");
    } finally {
      setWorkingTaskId(null);
    }
  }

  async function retryActiveTaskGoogleSync(task: TaskItem) {
    if (!sessionToken) return;

    setWorkingTaskId(task.id);
    setError(null);
    diagnostics.trackAction("retry_task_google_sync", { taskId: task.id, route: "/today" });

    try {
      await retryTaskGoogleSyncRequest({ sessionToken, taskId: task.id });
      setGoogleTaskNotice({
        tone: "success",
        message: task.linked_google_task || task.google_task_id ? "Синхронізацію з Google Tasks оновлено." : "Задачу створено в Google Tasks."
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
      setError(retryError instanceof Error ? retryError.message : "Не вдалося синхронізувати задачу з Google Tasks");
    } finally {
      setWorkingTaskId(null);
    }
  }

  async function applyInboundGoogleTaskChange(task: TaskItem) {
    if (!sessionToken) {
      setError("Спочатку авторизуйся в Інбоксі.");
      return;
    }

    setWorkingTaskId(task.id);
    setError(null);
    diagnostics.trackAction("apply_task_google_inbound", { taskId: task.id, route: "/today" });

    try {
      const state = await applyTaskGoogleInbound({ sessionToken, taskId: task.id });
      setGoogleTaskNotice({
        tone: "success",
        message: state.message ?? "Зміни з Google Tasks застосовано."
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
      setGoogleTaskNotice({ tone: "error", message: "Не вдалося застосувати зміни з Google Tasks." });
      setError(applyError instanceof Error ? applyError.message : "Не вдалося застосувати зміни з Google Tasks.");
    } finally {
      setWorkingTaskId(null);
    }
  }

  async function detachActiveTaskGoogleLink(task: TaskItem) {
    if (!sessionToken) {
      setError("Спочатку авторизуйся в Інбоксі.");
      return;
    }

    setWorkingTaskId(task.id);
    setError(null);
    diagnostics.trackAction("detach_task_google_link", { taskId: task.id, route: "/today" });

    try {
      await detachTaskGoogleLinkRequest({ sessionToken, taskId: task.id });
      setGoogleTaskNotice({
        tone: "success",
        message: task.google_task_sync_mode === "app_managed" ? "Зв'язок із Google Tasks прибрано." : "Google Tasks від'єднано від задачі."
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
      setGoogleTaskNotice({ tone: "error", message: "Не вдалося від'єднати Google Tasks." });
      setError(detachError instanceof Error ? detachError.message : "Не вдалося від'єднати Google Tasks.");
    } finally {
      setWorkingTaskId(null);
    }
  }

  async function reconnectGoogleForTasks() {
    if (!sessionToken) {
      setError("Спочатку авторизуйся в Інбоксі.");
      return;
    }

    try {
      const returnPath = surface === "week" ? "/week" : "/today";
      const result = await startGoogleCalendarConnect({ sessionToken, returnPath });
      if (window.Telegram?.WebApp?.openLink) {
        window.Telegram.WebApp.openLink(result.authUrl);
        return;
      }
      window.open(result.authUrl, "_blank", "noopener,noreferrer");
    } catch (connectError) {
      if (connectError instanceof ApiError) {
        diagnostics.trackFailure({
          path: connectError.path,
          status: connectError.status,
          code: connectError.code,
          message: connectError.message,
          details: connectError.details
        });
      }
      setError(connectError instanceof Error ? connectError.message : "Не вдалося почати перепідключення Google.");
    }
  }

  async function saveCalendarBlock(input: {
    title: string;
    description: string;
    startAt: string;
    endAt: string | null;
    timezone: string;
    projectId: string | null;
    recurrenceFrequency: "daily" | "weekly" | "monthly" | null;
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
        projectId: input.projectId,
        recurrenceFrequency: input.recurrenceFrequency
      });
      setCalendarBlockCreateOpen(false);
      setCalendarBlockModalMode("view");
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

    const confirmed = window.confirm(activeCalendarBlock?.recurrence_rule ? "Видалити лише цей повтор із календаря?" : "Видалити цей блок із календаря?");
    if (!confirmed) return;

    setCalendarBlockBusy(true);
    setCalendarBlockError(null);
    diagnostics.trackAction("delete_calendar_block_from_today", {
      blockId: activeCalendarBlock.id,
      route: surface === "week" ? "/week" : "/today"
    });

    try {
      await deleteCalendarBlock({ sessionToken, id: activeCalendarBlock.id });
      setCalendarBlockCreateOpen(false);
      setCalendarBlockModalMode("view");
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
        <button type="button" className="ghost" onClick={() => openTaskDetails(task)} disabled={isBusy}>
          {needsPlanningTouch(task) ? "Відкрити деталі" : "Переглянути"}
        </button>
      </div>
    );
  }

  function renderTimelineTaskRow(task: TaskItem, options?: { nested?: boolean; compact?: boolean; style?: Record<string, string> }) {
    const isBusy = workingTaskId === task.id;
    const nested = options?.nested ?? false;
    const compact = options?.compact ?? false;
    const start = parseDateOrNull(task.scheduled_for);
    const durationMinutes = task.estimated_minutes && task.estimated_minutes > 0 ? task.estimated_minutes : 30;
    const cardStyle = nested
      ? { minHeight: `${timelineHeight(durationMinutes, TIMELINE_NESTED_TASK_MIN_HEIGHT)}px` }
      : { minHeight: `${timelineHeight(durationMinutes, TIMELINE_TASK_MIN_HEIGHT)}px` };
    return (
      <li
        className={`day-timeline__task-row${nested ? " day-timeline__task-row--nested" : ""}${compact ? " day-timeline__task-row--compact" : ""}`}
        key={task.id}
        style={{ ...cardStyle, ...options?.style }}
      >
        <button
          type="button"
          className={`ghost day-timeline__quick-action${compact ? " day-timeline__quick-action--compact" : ""}`}
          onClick={() => void markTaskDone(task)}
          disabled={isBusy}
          aria-label={`Позначити задачу "${task.title}" виконаною`}
        >
          {isBusy ? "..." : "○"}
        </button>
        <div className="day-timeline__task-main">
          <button
            type="button"
            className={`day-timeline__title day-timeline__title--task${nested ? " day-timeline__title--task-nested" : ""}${compact ? " day-timeline__title--task-compact" : ""}`}
            onClick={() => openTaskDetails(task)}
            disabled={isBusy}
          >
            {task.title}
            {task.recurrence_rule ? <span className="recurrence-badge recurrence-badge--timeline">{recurrenceLabel(task.recurrence_rule)}</span> : null}
          </button>
          <p className={`day-timeline__meta day-timeline__meta--tight${compact ? " day-timeline__meta--compact-time" : ""}`}>
            {start ? formatTaskTimelineRange(task) : formatTaskTimingSummary(task)}
          </p>
        </div>
      </li>
    );
  }

  function renderDayTimeline() {
    return (
      <section className="today-section day-timeline-section">
        <div className="day-timeline-section__header">
          <div>
            <h3>Лінія дня</h3>
            <p className="inbox-meta">
              {scheduledToday.length > 0
                ? `Заплановано на день: ${scheduledToday.length}. Дедлайни без плану: ${dueTodayWithoutSchedule.length}.`
                : dueTodayWithoutSchedule.length > 0
                  ? `Запланованих задач на день поки немає. Є ${dueTodayWithoutSchedule.length} дедлайнів без планованого старту.`
                  : "Часові блоки й заплановані задачі зібрані в один денний потік без дублювання секцій."}
            </p>
            <p className="inbox-meta">
              {loadCoverageLine({
                knownMinutes: todayKnownEstimateMinutes,
                missingCount: todayMissingEstimateCount,
                plannedCount: scheduledToday.length
              })}
            </p>
          </div>
          <div className="today-toolbar__actions">
            <button type="button" className="ghost" onClick={() => startCreateCalendarBlock()} disabled={!sessionToken || calendarBlockBusy}>
              Додати блок
            </button>
          </div>
        </div>
        {!visibleDayWindow || (blockTimelineLayouts.length === 0 && scheduledTaskLayouts.length === 0) ? (
          <p className="empty-note">
            {calendarStatus?.connected
              ? "На цей день ще немає часових блоків або запланованих задач."
              : "На цей день ще немає запланованих задач. Календар можна підключити на вкладці «Календар»."}
          </p>
        ) : (
          <div className="day-timeline-shell">
            <div className="day-timeline-scale" style={{ height: `${timelineCanvasHeight}px` }}>
              {hourMarks.map((mark) => (
                <div key={mark.label} className="day-timeline-scale__mark" style={{ top: `${mark.top}px` }}>
                  <span className="day-timeline-scale__label">{mark.label}</span>
                </div>
              ))}
            </div>
            <div className="day-timeline-scroll">
            <div className="day-timeline-canvas" style={{ height: `${timelineCanvasHeight}px`, minWidth: `${timelineCanvasMinWidth}px` }}>
              {hourMarks.map((mark) => (
                <div key={`line-${mark.label}`} className="day-timeline-canvas__line" style={{ top: `${mark.top}px` }} />
              ))}
              {currentTimeOffset !== null ? (
                <div className="day-timeline-canvas__now" style={{ top: `${currentTimeOffset}px` }} />
              ) : null}
              {blockTimelineLayouts.map((entry) => {
                const laneStyle = timelineLaneStyle(entry.lane, entry.laneCount);
                return (
                  <div
                    key={entry.block.id}
                    className="day-timeline-block"
                    style={{
                      top: `${entry.top}px`,
                      height: `${entry.height}px`,
                      left: laneStyle.left,
                      width: laneStyle.width
                    }}
                  >
                    <div className="day-timeline__card day-timeline__container">
                      <div className="day-timeline__container-header">
                        <div>
                          <button
                            type="button"
                            className="day-timeline__title"
                            onClick={() => openCalendarBlock(entry.block)}
                            disabled={calendarBlockBusy}
                          >
                            {entry.block.title}
                            {entry.block.recurrence_rule ? <span className="recurrence-badge recurrence-badge--timeline">{recurrenceLabel(entry.block.recurrence_rule)}</span> : null}
                          </button>
                          <p className="day-timeline__meta day-timeline__meta--tight">
                            {formatBlockTimelineRange(entry.block)}
                          </p>
                          {entry.block.recurrence_rule ? <p className="day-timeline__meta day-timeline__meta--subtle">Зараз редагується лише цей повтор.</p> : null}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
              {taskCollisionGroups.map((group) => {
                return (
                  <div
                    key={`task-group-${group.key}`}
                    className="day-timeline-task-group"
                    style={{ top: `${group.top}px`, height: `${group.height}px`, left: group.left, width: group.width }}
                  >
                    {group.entries.map((entry) => {
                      const collisionStyle = timelineTaskCollisionStyle(entry.collisionLane, entry.collisionLaneCount);
                      return (
                        <div
                          key={entry.task.id}
                          className={`day-timeline-task day-timeline-task--grouped${entry.preservesBlockHeader ? " day-timeline-task--header-preserve" : ""}`}
                          style={{
                            top: `${entry.top - group.top}px`,
                            height: `${entry.height}px`,
                            left: collisionStyle.left,
                            width: collisionStyle.width,
                            zIndex: `${12 + entry.collisionLane}`
                          }}
                        >
                          {renderTimelineTaskRow(entry.task, {
                            nested: true,
                            compact: true,
                            style: {
                              height: `${entry.height}px`
                            }
                          })}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
              {scheduledTaskLayouts
                .filter((entry) => entry.collisionLaneCount <= 1)
                .map((entry) => (
                <div
                  key={entry.task.id}
                  className={`day-timeline-task${entry.nested ? " day-timeline-task--nested" : ""}${entry.preservesBlockHeader ? " day-timeline-task--header-preserve" : ""}`}
                  style={{ top: `${entry.top}px`, height: `${entry.height}px`, left: entry.left, width: entry.width }}
                >
                  {renderTimelineTaskRow(entry.task, {
                    nested: entry.nested,
                    compact: entry.nested,
                    style: {
                      height: `${entry.height}px`
                    }
                  })}
                </div>
              ))}
            </div>
            </div>
          </div>
        )}
        {nextCalendarEvent ? (
          <p className="inbox-meta">
            Наступна подія після цього дня: {nextCalendarEvent.title} / {formatCalendarEventTimeRange(nextCalendarEvent)}
          </p>
        ) : null}
      </section>
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
                  {task.recurrence_rule ? <span className="recurrence-badge">{recurrenceLabel(task.recurrence_rule)}</span> : null}
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
                {recurringShortHint(task.recurrence_rule) ? <p className="inbox-meta">{recurringShortHint(task.recurrence_rule)} · Дії стосуються лише цього повтору.</p> : null}
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
      {pageNotice ? <p className={pageNotice.tone === "error" ? "error-note" : "inbox-meta"}>{pageNotice.message}</p> : null}
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
                    <p className="inbox-main-text">
                      {block.title}
                      {block.recurrence_rule ? <span className="recurrence-badge">{recurrenceLabel(block.recurrence_rule)}</span> : null}
                    </p>
                    <p className="inbox-meta">{formatCalendarEventTimeRange(block)}</p>
                    <p className="inbox-meta block-row__meta">{block.source === "google" ? "Подія з Google Calendar" : "Блок із додатку"} · Проєкт: {projectNameForCalendarBlock(block)}</p>
                    {block.recurrence_rule ? <p className="inbox-meta">Зараз відкривається лише цей повтор.</p> : null}
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
          {renderDayTimeline()}
          {renderSection(isSelectedToday ? "Заплановане раніше" : "Заплановане до цієї дати", isSelectedToday ? "Тут задачі, які вже мали стартувати раніше й досі лишаються відкритими." : "Тут задачі, які мали стартувати ще до цієї дати й досі лишаються відкритими.", overdueScheduled, "neutral")}
          {renderSection(isSelectedToday ? "\u0414\u0435\u0434\u043b\u0430\u0439\u043d\u0438 \u0441\u044c\u043e\u0433\u043e\u0434\u043d\u0456 \u0431\u0435\u0437 \u043f\u043b\u0430\u043d\u0443" : "\u0414\u0435\u0434\u043b\u0430\u0439\u043d\u0438 \u0446\u044c\u043e\u0433\u043e \u0434\u043d\u044f \u0431\u0435\u0437 \u043f\u043b\u0430\u043d\u0443", "\u041e\u043a\u0440\u0435\u043c\u043e \u043f\u043e\u043a\u0430\u0437\u0430\u043d\u0456 \u0437\u0430\u0434\u0430\u0447\u0456 \u0437 \u0434\u0435\u0434\u043b\u0430\u0439\u043d\u043e\u043c \u043d\u0430 \u0432\u0438\u0431\u0440\u0430\u043d\u0438\u0439 \u0434\u0435\u043d\u044c, \u0430\u043b\u0435 \u0431\u0435\u0437 \u043f\u043b\u0430\u043d\u043e\u0432\u0430\u043d\u043e\u0433\u043e \u0441\u0442\u0430\u0440\u0442\u0443.", dueTodayWithoutSchedule, "unscheduled")}
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
        recurrenceRuleHint={activeCalendarBlock?.recurrence_rule ?? null}
        recurrenceTimezoneHint={activeCalendarBlock?.recurrence_timezone ?? null}
        projectOptions={projects}
        heading={activeCalendarBlock ? "Деталі блоку" : "Новий блок"}
        subtitle={
          activeCalendarBlock
            ? activeCalendarBlock.source === "google"
              ? "Подія прийшла з Google Calendar, але її можна спокійно змінити тут."
              : "Блок створено в додатку й синхронізовано з Google Calendar."
            : "Новий блок одразу збережеться в календарі й з'явиться в планувальних surfaces."
        }
        initialMode={calendarBlockCreateOpen ? "create" : calendarBlockModalMode}
        confirmLabel={activeCalendarBlock ? "Зберегти зміни" : "Створити блок"}
        deleteLabel="Видалити блок"
        readOnlyReason={activeCalendarBlock?.is_all_day ? "Події на весь день поки що можна редагувати тільки в Google Calendar." : null}
        busy={calendarBlockBusy}
        errorMessage={calendarBlockError}
        onCancel={() => {
          if (calendarBlockBusy) return;
          setCalendarBlockCreateOpen(false);
          setActiveCalendarBlock(null);
          setCalendarBlockModalMode("view");
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
        googleTaskSyncNotice={activeTask ? googleTaskNotice : null}
        googleTaskInboundState={activeTask ? googleTaskInboundState : null}
        initialMode={taskModalMode === "create" ? "create" : taskModalMode}
        createDefaults={todayTaskCreateDefaults}
        onClose={() => {
          setActiveTask(null);
          setTaskModalMode("view");
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
                planningFlexibility: payload.planningFlexibility,
                recurrenceFrequency: payload.recurrenceFrequency
              });
              if (created) {
                setActiveTask(null);
                setTaskModalMode("view");
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
              planningFlexibility: payload.planningFlexibility,
              recurrenceFrequency: payload.recurrenceFrequency
            });
            if (saved) { setActiveTask(null); setTaskModalMode("view"); }
          })();
        }}
        onDelete={() => {
          void deleteCurrentTask();
        }}
        onAction={(action) => {
          if (!activeTask) return;
          void runTaskWorkflowAction(activeTask, action);
        }}
        onCreateCalendarEvent={() => {
          if (!activeTask) return;
          if (!calendarStatus?.connected) {
            setError("Google Calendar не підключено. Відкрий вкладку «Календар» і підключи акаунт.");
            return;
          }
          void retryActiveTaskCalendarSync(activeTask);
        }}
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
        onRetryGoogleTaskSync={() => {
          if (!activeTask) return;
          void retryActiveTaskGoogleSync(activeTask);
        }}
        onDetachGoogleTaskLink={() => {
          if (!activeTask) return;
          void detachActiveTaskGoogleLink(activeTask);
        }}
        onApplyGoogleTaskInbound={() => {
          if (!activeTask) return;
          void applyInboundGoogleTaskChange(activeTask);
        }}
        onReconnectGoogle={() => {
          void reconnectGoogleForTasks();
        }}
        onKeepCalendarAppVersion={() => {
          if (!activeTask) return;
          void keepCalendarAppVersion(activeTask);
        }}
        onOpenLinkedCalendarEvent={(url) => {
          diagnostics.trackAction("open_task_linked_calendar_event", { taskId: activeTask?.id, route: "/today" });
          try {
            if (window.Telegram?.WebApp?.openLink) {
              window.Telegram.WebApp.openLink(url);
              return;
            }
            window.open(url, "_blank", "noopener,noreferrer");
          } catch {
            window.location.href = url;
          }
        }}
        showWorkflowActions
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























































