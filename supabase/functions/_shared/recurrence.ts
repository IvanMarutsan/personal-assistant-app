export type SupportedRecurrenceFrequency = "daily" | "weekly" | "monthly";

export function parseSupportedRecurrenceFrequency(value: string | null | undefined): SupportedRecurrenceFrequency | null {
  if (!value) return null;
  if (value === "daily" || value === "weekly" || value === "monthly") return value;
  return null;
}

export function buildSupportedRecurrenceRule(frequency: SupportedRecurrenceFrequency | null | undefined): string | null {
  if (!frequency) return null;
  if (frequency === "daily") return "RRULE:FREQ=DAILY;INTERVAL=1";
  if (frequency === "weekly") return "RRULE:FREQ=WEEKLY;INTERVAL=1";
  if (frequency === "monthly") return "RRULE:FREQ=MONTHLY;INTERVAL=1";
  return null;
}

export function parseSupportedRecurrenceRule(rule: string | null | undefined): SupportedRecurrenceFrequency | null {
  if (!rule) return null;
  const normalized = rule.trim().toUpperCase();
  if (normalized.includes("FREQ=DAILY")) return "daily";
  if (normalized.includes("FREQ=WEEKLY")) return "weekly";
  if (normalized.includes("FREQ=MONTHLY")) return "monthly";
  return null;
}

export function nextRecurringInstant(value: string | null | undefined, frequency: SupportedRecurrenceFrequency): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;

  const next = new Date(parsed);
  if (frequency === "daily") {
    next.setUTCDate(next.getUTCDate() + 1);
  } else if (frequency === "weekly") {
    next.setUTCDate(next.getUTCDate() + 7);
  } else {
    next.setUTCMonth(next.getUTCMonth() + 1);
  }
  return next.toISOString();
}
