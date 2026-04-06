import type { VoiceAiSuggestion, VoiceConfirmTargetKind } from "../types/api";

export type InterruptTriageRecommendationCode = "do_now" | "later_today" | "backlog" | "worklog" | "dismiss";

export type InterruptTriageRecommendation = {
  code: InterruptTriageRecommendationCode;
  label: string;
  summary: string;
  actionHint: string;
  suggestedTarget: VoiceConfirmTargetKind | "discard";
};

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\'`’]/g, "")
    .replace(/[^\p{L}\p{N}\s:.+-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasAny(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(term));
}

function isSameLocalDay(iso: string | null | undefined, base: Date): boolean {
  if (!iso) return false;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return false;
  return (
    parsed.getFullYear() === base.getFullYear() &&
    parsed.getMonth() === base.getMonth() &&
    parsed.getDate() === base.getDate()
  );
}

function recommendation(code: InterruptTriageRecommendationCode): InterruptTriageRecommendation {
  switch (code) {
    case "do_now":
      return {
        code,
        label: "Зробити зараз",
        summary: "Схоже на коротку реактивну дію, яку краще швидко закрити.",
        actionHint: "Якщо це задача, розглянь швидке виконання без розтягування дня.",
        suggestedTarget: "task"
      };
    case "later_today":
      return {
        code,
        label: "Пізніше сьогодні",
        summary: "Схоже на дію для цього дня, але не обов'язково негайно.",
        actionHint: "Якщо збережеш як задачу, варто поставити її на сьогодні.",
        suggestedTarget: "task"
      };
    case "worklog":
      return {
        code,
        label: "У контекст",
        summary: "Схоже на факт, переривання або вже закриту реактивну дрібницю.",
        actionHint: "Не перетворюй це на нову задачу, якщо дія вже відбулась.",
        suggestedTarget: "worklog"
      };
    case "dismiss":
      return {
        code,
        label: "Без окремої дії",
        summary: "Окремої задачі тут не видно. Можна відхилити або лишити нотаткою.",
        actionHint: "Якщо це лише сигнал або шум, не обов'язково зберігати як задачу.",
        suggestedTarget: "discard"
      };
    case "backlog":
    default:
      return {
        code: "backlog",
        label: "У беклог",
        summary: "Схоже на окрему дію без потреби втручатися просто зараз.",
        actionHint: "Якщо збережеш як задачу, можна лишити її без часу.",
        suggestedTarget: "task"
      };
  }
}

export function recommendInterruptTriage(input: {
  sourceText: string;
  suggestion?: VoiceAiSuggestion | null;
  now?: Date;
}): InterruptTriageRecommendation {
  const now = input.now ?? new Date();
  const text = normalizeText(input.sourceText || input.suggestion?.details || input.suggestion?.title || "");
  const intent = input.suggestion?.detectedIntent ?? null;
  const dueHint = normalizeText(input.suggestion?.dueHint ?? "");
  const datetimeHint = normalizeText(input.suggestion?.datetimeHint ?? "");
  const taskType = input.suggestion?.taskTypeGuess ?? null;
  const confidence = input.suggestion?.confidence ?? null;

  const worklogSignals =
    intent === "worklog_candidate" ||
    hasAny(text, [
      "відволік",
      "перемкнув",
      "розрулив",
      "закрив",
      "відповів",
      "відписав",
      "обробив",
      "пофіксив",
      "зробив кілька",
      "reactive",
      "context switch",
      "interruption",
      "switched context",
      "handled",
      "fixed a few",
      "replied to"
    ]);
  if (worklogSignals) return recommendation("worklog");

  const dismissSignals =
    hasAny(text, ["ок", "дякую", "thanks", "noted", "побачив", "прийняв", "received"]) &&
    text.length <= 24;
  if (dismissSignals || (intent === "note" && (confidence ?? 0) < 0.55 && !dueHint && !datetimeHint)) {
    return recommendation("dismiss");
  }

  const backlogSignals =
    taskType === "someday" ||
    hasAny(text, ["на потім", "пізніше", "коли буде час", "не терміново", "someday", "later", "backlog"]);
  if (backlogSignals) return recommendation("backlog");

  const urgentSignals =
    hasAny(text, ["терміново", "зараз", "негайно", "asap", "urgent", "палає", "горить", "сьогодні треба", "до дзвінка"]) ||
    ((taskType === "quick_communication" || taskType === "admin_operational") && (input.suggestion?.importanceGuess ?? 0) >= 4);
  if (urgentSignals) return recommendation("do_now");

  const todaySignals =
    hasAny(dueHint, ["сьогодні", "today", "до вечора", "до кінця дня"]) ||
    hasAny(datetimeHint, ["сьогодні", "today", "після обіду", "увечері", "afternoon", "evening"]) ||
    isSameLocalDay(input.suggestion?.scheduledForIso, now) ||
    isSameLocalDay(input.suggestion?.dueAtIso, now) ||
    taskType === "quick_communication" ||
    taskType === "admin_operational";
  if (todaySignals) return recommendation("later_today");

  if (intent === "note") return recommendation("dismiss");
  return recommendation("backlog");
}

export function recommendationDefaultKind(rec: InterruptTriageRecommendation): VoiceConfirmTargetKind {
  if (rec.suggestedTarget === "worklog") return "worklog";
  if (rec.suggestedTarget === "note") return "note";
  if (rec.suggestedTarget === "calendar_event") return "calendar_event";
  return "task";
}
