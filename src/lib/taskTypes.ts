import type { TaskType } from "../types/api";

export const MANUAL_TASK_TYPE_OPTIONS: Array<{ value: TaskType; label: string }> = [
  { value: "communication", label: "Комунікація" },
  { value: "publishing", label: "Публікація" },
  { value: "admin", label: "Адміністративне" },
  { value: "planning", label: "Планування" },
  { value: "tech", label: "Технічне" },
  { value: "content", label: "Контент" },
  { value: "meeting", label: "Зустріч" },
  { value: "review", label: "Огляд" }
];

export const LEGACY_TASK_TYPE_OPTIONS: Array<{ value: TaskType; label: string }> = [
  { value: "deep_work", label: "Глибока робота" },
  { value: "quick_communication", label: "Швидка комунікація" },
  { value: "admin_operational", label: "Адміністративне" },
  { value: "recurring_essential", label: "Регулярне важливе" },
  { value: "personal_essential", label: "Особисто важливе" },
  { value: "someday", label: "Колись" }
];

export const TASK_TYPE_FILTER_OPTIONS: Array<{ value: TaskType; label: string }> = [
  ...MANUAL_TASK_TYPE_OPTIONS,
  ...LEGACY_TASK_TYPE_OPTIONS.filter((option) => !MANUAL_TASK_TYPE_OPTIONS.some((manualOption) => manualOption.value === option.value))
];

const TASK_TYPE_LABELS: Record<TaskType, string> = TASK_TYPE_FILTER_OPTIONS.reduce((acc, option) => {
  acc[option.value] = option.label;
  return acc;
}, {} as Record<TaskType, string>);

const LEGACY_TASK_TYPES = new Set<TaskType>(LEGACY_TASK_TYPE_OPTIONS.map((option) => option.value));

export function taskTypeLabel(value: TaskType): string {
  return TASK_TYPE_LABELS[value] ?? value;
}

export function buildTaskTypeOptions(currentValue?: TaskType | null): Array<{ value: TaskType; label: string }> {
  if (!currentValue || !LEGACY_TASK_TYPES.has(currentValue)) return MANUAL_TASK_TYPE_OPTIONS;
  if (MANUAL_TASK_TYPE_OPTIONS.some((option) => option.value === currentValue)) return MANUAL_TASK_TYPE_OPTIONS;
  return [...MANUAL_TASK_TYPE_OPTIONS, { value: currentValue, label: taskTypeLabel(currentValue) }];
}

export function isCommunicationTaskType(value: TaskType): boolean {
  return value === "communication" || value === "quick_communication";
}

export function isAdminTaskType(value: TaskType): boolean {
  return value === "admin" || value === "admin_operational";
}
