export type RecurrenceFrequency = "daily" | "weekly" | "monthly";

export const RECURRENCE_OPTIONS: Array<{ value: RecurrenceFrequency | ""; label: string }> = [
  { value: "", label: "Не повторюється" },
  { value: "daily", label: "Щодня" },
  { value: "weekly", label: "Щотижня" },
  { value: "monthly", label: "Щомісяця" }
];

export function buildRecurrenceRule(frequency: RecurrenceFrequency | null | undefined): string | null {
  if (!frequency) return null;
  if (frequency === "daily") return "RRULE:FREQ=DAILY;INTERVAL=1";
  if (frequency === "weekly") return "RRULE:FREQ=WEEKLY;INTERVAL=1";
  if (frequency === "monthly") return "RRULE:FREQ=MONTHLY;INTERVAL=1";
  return null;
}

export function parseRecurrenceFrequency(rule: string | null | undefined): RecurrenceFrequency | null {
  if (!rule) return null;
  const normalized = rule.trim().toUpperCase();
  if (normalized.includes("FREQ=DAILY")) return "daily";
  if (normalized.includes("FREQ=WEEKLY")) return "weekly";
  if (normalized.includes("FREQ=MONTHLY")) return "monthly";
  return null;
}

export function recurrenceLabel(rule: string | null | undefined): string | null {
  const frequency = parseRecurrenceFrequency(rule);
  if (!frequency) return null;
  if (frequency === "daily") return "Щодня";
  if (frequency === "weekly") return "Щотижня";
  return "Щомісяця";
}
