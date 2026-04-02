import { useEffect, useMemo, useState } from "react";
import type { MoveReasonCode } from "../types/api";

type TaskActionModalAction = "postpone" | "reschedule" | "block" | "cancel";

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
  { code: "reprioritized", label: "reprioritized" },
  { code: "urgent_interrupt", label: "urgent_interrupt" },
  { code: "low_energy", label: "low_energy" },
  { code: "waiting_response", label: "waiting_response" },
  { code: "underestimated", label: "underestimated" },
  { code: "blocked_dependency", label: "blocked_dependency" },
  { code: "calendar_conflict", label: "calendar_conflict" },
  { code: "personal_issue", label: "personal_issue" },
  { code: "other", label: "other" }
];

function titleForAction(action: TaskActionModalAction | null): string {
  if (action === "postpone") return "Postpone task";
  if (action === "reschedule") return "Reschedule task";
  if (action === "block") return "Block task";
  if (action === "cancel") return "Cancel task";
  return "Task action";
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
        setError("Postpone minutes must be a positive number.");
        return;
      }
      payload.postponeMinutes = parsed;
    }

    if (needsRescheduleTo) {
      if (!rescheduleTo.trim()) {
        setError("Reschedule datetime is required.");
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

        <label>
          Reason code
          <select value={reasonCode} onChange={(event) => setReasonCode(event.target.value as MoveReasonCode)}>
            {MOVE_REASONS.map((reason) => (
              <option key={reason.code} value={reason.code}>
                {reason.label}
              </option>
            ))}
          </select>
        </label>

        <label>
          Optional note
          <textarea
            value={reasonText}
            onChange={(event) => setReasonText(event.target.value)}
            rows={3}
            placeholder="Optional context"
          />
        </label>

        {needsPostponeMinutes ? (
          <label>
            Postpone minutes
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
            Reschedule to
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
            Cancel
          </button>
          <button type="button" onClick={submit} disabled={props.busy}>
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
