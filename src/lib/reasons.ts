import type { MoveReasonCode } from "../types/api";

const MOVE_REASON_LABELS: Record<MoveReasonCode, string> = {
  reprioritized: "Репріоритизація",
  urgent_interrupt: "Термінове переривання",
  low_energy: "Низький рівень енергії",
  waiting_response: "Очікування відповіді",
  waiting_on_external: "Очікування зовнішнього сигналу",
  underestimated: "Недооцінка обсягу",
  blocked_dependency: "Блокер / залежність",
  calendar_conflict: "Конфлікт у календарі",
  personal_issue: "Особисті обставини",
  other: "Інше"
};

export function moveReasonLabel(reason: MoveReasonCode | null | undefined): string | null {
  if (!reason) return null;
  return MOVE_REASON_LABELS[reason] ?? reason;
}
