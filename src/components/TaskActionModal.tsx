import { useEffect, useMemo, useState } from "react";
import type { MoveReasonCode } from "../types/api";

type TaskActionModalAction = "postpone" | "reschedule" | "block" | "unblock" | "cancel";

type TaskActionPayload = {
  reasonCode: MoveReasonCode;
  reasonText?: string;
  postponeMinutes?: number;
  rescheduleTo?: string;
};

type TaskActionModalProps = {
  open: boolean;
  action: TaskActionModalAction | null;
  taskTitle: string | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (payload: TaskActionPayload) => void;
};

const MOVE_REASONS: Array<{ code: MoveReasonCode; label: string }> = [
  { code: "reprioritized", label: "Репріоритизація" },
  { code: "urgent_interrupt", label: "Термінове переривання" },
  { code: "low_energy", label: "Низький рівень енергії" },
  { code: "waiting_response", label: "Очікую відповідь" },
  { code: "waiting_on_external", label: "Очікую зовнішній сигнал" },
  { code: "underestimated", label: "Недооцінив(ла) обсяг" },
  { code: "blocked_dependency", label: "Блокер / залежність" },
  { code: "calendar_conflict", label: "Конфлікт у календарі" },
  { code: "personal_issue", label: "Особисті обставини" },
  { code: "other", label: "Інше" }
];

function titleForAction(action: TaskActionModalAction | null): string {
  if (action === "postpone") return "Відкласти задачу";
  if (action === "reschedule") return "Перенести задачу";
  if (action === "block") return "Позначити як заблоковану";
  if (action === "unblock") return "Розблокувати задачу";
  if (action === "cancel") return "Скасувати задачу";
  return "Дія із задачею";
}

function helperForAction(action: TaskActionModalAction | null): string {
  if (action === "postpone") return "Швидка затримка на відносний час (хвилини).";
  if (action === "reschedule") return "Постав нову конкретну дату й час.";
  if (action === "block") return "Задача лишається у списку, але позначається як заблокована.";
  if (action === "unblock") return "Поверне задачу у статус «Заплановано».";
  if (action === "cancel") return "Задача буде скасована і зникне з активного фокусу.";
  return "";
}

export function TaskActionModal(props: TaskActionModalProps) {
  const [reasonCode, setReasonCode] = useState<MoveReasonCode>("reprioritized");
  const [reasonText, setReasonText] = useState("");
  const [postponeMinutes, setPostponeMinutes] = useState("1440");
  const [rescheduleTo, setRescheduleTo] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!props.open) return;
    setReasonCode("reprioritized");
    setReasonText("");
    setPostponeMinutes("1440");
    setRescheduleTo("");
    setError(null);
  }, [props.open, props.action]);

  const needsPostponeMinutes = props.action === "postpone";
  const needsRescheduleTo = props.action === "reschedule";

  const actionLabel = useMemo(() => titleForAction(props.action), [props.action]);
  const actionHelper = useMemo(() => helperForAction(props.action), [props.action]);

  if (!props.open || !props.action) {
    return null;
  }

  function submit() {
    setError(null);

    const payload: TaskActionPayload = {
      reasonCode,
      reasonText: reasonText.trim() || undefined
    };

    if (needsPostponeMinutes) {
      const parsed = Number.parseInt(postponeMinutes, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        setError("Кількість хвилин має бути додатним числом.");
        return;
      }
      payload.postponeMinutes = parsed;
    }

    if (needsRescheduleTo) {
      if (!rescheduleTo.trim()) {
        setError("Вкажи нову дату й час.");
        return;
      }
      payload.rescheduleTo = rescheduleTo.trim();
    }

    props.onConfirm(payload);
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal-card">
        <h3>{actionLabel}</h3>
        {props.taskTitle ? <p className="modal-task-title">{props.taskTitle}</p> : null}
        {actionHelper ? <p className="inbox-meta">{actionHelper}</p> : null}

        <label>
          Причина
          <select value={reasonCode} onChange={(event) => setReasonCode(event.target.value as MoveReasonCode)}>
            {MOVE_REASONS.map((reason) => (
              <option key={reason.code} value={reason.code}>
                {reason.label}
              </option>
            ))}
          </select>
        </label>

        <label>
          Коментар (необов'язково)
          <textarea
            value={reasonText}
            onChange={(event) => setReasonText(event.target.value)}
            rows={3}
            placeholder="Деталі причини"
          />
        </label>

        {needsPostponeMinutes ? (
          <label>
            На скільки хвилин відкласти
            <input
              type="number"
              min={1}
              value={postponeMinutes}
              onChange={(event) => setPostponeMinutes(event.target.value)}
            />
          </label>
        ) : null}

        {needsRescheduleTo ? (
          <label>
            Нова дата й час
            <input
              type="datetime-local"
              value={rescheduleTo}
              onChange={(event) => setRescheduleTo(event.target.value)}
            />
          </label>
        ) : null}

        {error ? <p className="error-note">{error}</p> : null}

        <div className="modal-actions">
          <button type="button" onClick={props.onCancel} disabled={props.busy}>
            Скасувати
          </button>
          <button type="button" onClick={submit} disabled={props.busy}>
            Підтвердити
          </button>
        </div>
      </div>
    </div>
  );
}
