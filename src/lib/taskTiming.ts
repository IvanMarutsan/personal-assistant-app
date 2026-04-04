import type { TaskItem } from "../types/api";

const USER_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

type TimingTask = Pick<TaskItem, "title" | "status" | "scheduled_for" | "due_at" | "estimated_minutes">;

export function parseTaskDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function formatTaskDateTime(value: Date, timezone = USER_TIMEZONE): string {
  return new Intl.DateTimeFormat("uk-UA", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: timezone
  }).format(value);
}

export function formatTaskEstimate(value: number | null | undefined): string | null {
  if (!value) return null;
  return `${value} хв`;
}

export function isBacklogTask(task: Pick<TaskItem, "scheduled_for">): boolean {
  return !task.scheduled_for;
}

export function isScheduledForDay(task: Pick<TaskItem, "scheduled_for">, start: Date, end: Date): boolean {
  const scheduled = parseTaskDate(task.scheduled_for);
  return !!scheduled && scheduled >= start && scheduled <= end;
}

export function isDueOnDay(task: Pick<TaskItem, "due_at">, start: Date, end: Date): boolean {
  const due = parseTaskDate(task.due_at);
  return !!due && due >= start && due <= end;
}

export function sortTasksByTimeField<T extends Pick<TaskItem, "title" | "scheduled_for" | "due_at">>(
  tasks: T[],
  field: "scheduled_for" | "due_at"
): T[] {
  return [...tasks].sort((a, b) => {
    const aTs = parseTaskDate(a[field])?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const bTs = parseTaskDate(b[field])?.getTime() ?? Number.MAX_SAFE_INTEGER;
    if (aTs !== bTs) return aTs - bTs;
    return a.title.localeCompare(b.title, "uk-UA");
  });
}

export function formatTaskTimingSummary(task: TimingTask, timezone = USER_TIMEZONE): string {
  const scheduled = parseTaskDate(task.scheduled_for);
  const due = parseTaskDate(task.due_at);
  const estimate = formatTaskEstimate(task.estimated_minutes);
  const fragments: string[] = [];

  if (scheduled) {
    fragments.push(`Плановий старт: ${formatTaskDateTime(scheduled, timezone)}`);
  } else {
    fragments.push("Беклог");
  }

  if (due) {
    fragments.push(`Дедлайн: ${formatTaskDateTime(due, timezone)}`);
  }

  if (estimate) {
    fragments.push(`Оцінка: ${estimate}`);
  }

  return fragments.join(" · ");
}

export function formatTaskTimingTone(
  task: TimingTask,
  now = new Date(),
  timezone = USER_TIMEZONE
): { label: string; tone: "neutral" | "warn" | "ok" } {
  const scheduled = parseTaskDate(task.scheduled_for);
  const due = parseTaskDate(task.due_at);
  const reference = scheduled ?? due;
  const label = formatTaskTimingSummary(task, timezone);

  if (task.status !== "done" && task.status !== "cancelled" && reference && reference < now) {
    return { label: `${label} · Прострочено`, tone: "warn" };
  }

  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(now);
  todayEnd.setHours(23, 59, 59, 999);

  if (scheduled && scheduled >= todayStart && scheduled <= todayEnd) {
    return { label: `${label} · Сьогодні`, tone: "ok" };
  }

  return { label, tone: "neutral" };
}
