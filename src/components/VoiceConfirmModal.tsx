import { useEffect, useMemo, useState } from "react";
import type { ProjectItem, TaskType, VoiceAiSuggestion } from "../types/api";

type VoiceConfirmKind = "task" | "note";

type VoiceConfirmModalProps = {
  open: boolean;
  defaultKind: VoiceConfirmKind;
  suggestion: VoiceAiSuggestion | null;
  transcript: string;
  projectMatch?: {
    matchedProjectId: string | null;
    matchedProjectName: string | null;
    status: "matched" | "suggested_only" | "none";
    score: number | null;
  } | null;
  projects: ProjectItem[];
  busy: boolean;
  onCancel: () => void;
  onConfirm: (payload: {
    targetKind: VoiceConfirmKind;
    title: string;
    details: string;
    noteBody: string;
    projectId: string | null;
    taskType: TaskType | null;
    importance: number | null;
    dueAt: string | null;
    scheduledFor: string | null;
  }) => void;
};

const TASK_TYPE_OPTIONS: Array<{ value: TaskType; label: string }> = [
  { value: "deep_work", label: "Глибока робота" },
  { value: "quick_communication", label: "Швидка комунікація" },
  { value: "admin_operational", label: "Операційне" },
  { value: "recurring_essential", label: "Регулярне важливе" },
  { value: "personal_essential", label: "Особисто важливе" },
  { value: "someday", label: "Колись" }
];

function isoToLocalInput(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offsetMs = date.getTimezoneOffset() * 60_000;
  const localDate = new Date(date.getTime() - offsetMs);
  return localDate.toISOString().slice(0, 16);
}

function localInputToIso(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function buildNoteBody(title: string, details: string, dueAt: string, scheduledFor: string): string {
  const cleanTitle = title.trim();
  const cleanDetails = details.trim();
  const lines: string[] = [];
  if (cleanTitle) lines.push(cleanTitle);
  if (cleanDetails) {
    if (lines.length > 0) lines.push("");
    lines.push(cleanDetails);
  }
  if (dueAt || scheduledFor) {
    if (lines.length > 0) lines.push("");
    lines.push("Часові підказки:");
    if (scheduledFor) lines.push(`- Заплановано на: ${scheduledFor}`);
    if (dueAt) lines.push(`- Дедлайн: ${dueAt}`);
  }
  return lines.join("\n").trim();
}

export function VoiceConfirmModal(props: VoiceConfirmModalProps) {
  const [targetKind, setTargetKind] = useState<VoiceConfirmKind>("task");
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [projectId, setProjectId] = useState<string>("");
  const [taskType, setTaskType] = useState<TaskType | "">("");
  const [importance, setImportance] = useState<number | "">("");
  const [dueAtInput, setDueAtInput] = useState("");
  const [scheduledForInput, setScheduledForInput] = useState("");

  useEffect(() => {
    if (!props.open || !props.suggestion) return;
    setTargetKind(props.defaultKind);
    setTitle(props.suggestion.title ?? "");
    setDetails(props.suggestion.details || props.transcript || "");
    setProjectId(props.projectMatch?.matchedProjectId ?? "");
    setTaskType(props.suggestion.taskTypeGuess ?? "");
    setImportance(props.suggestion.importanceGuess ?? "");
    setDueAtInput(isoToLocalInput(props.suggestion.dueAtIso));
    setScheduledForInput(isoToLocalInput(props.suggestion.scheduledForIso));
  }, [props.open, props.suggestion, props.transcript, props.defaultKind, props.projectMatch]);

  const noteBody = useMemo(
    () => buildNoteBody(title, details, dueAtInput, scheduledForInput),
    [title, details, dueAtInput, scheduledForInput]
  );

  if (!props.open || !props.suggestion) return null;

  const submitDisabled = props.busy || (targetKind === "task" ? !title.trim() : !noteBody.trim());

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <section className="modal-card">
        <h3>Підтвердження голосового розбору</h3>
        <p className="modal-task-title">AI пропонує: відредагуй і підтвердь вручну</p>
        {props.projectMatch?.status === "matched" ? (
          <p className="inbox-meta">
            AI-guess проєкту зіставлено: {props.projectMatch.matchedProjectName ?? "невідомо"}
            {typeof props.projectMatch.score === "number"
              ? ` (${Math.round(props.projectMatch.score * 100)}%)`
              : ""}
          </p>
        ) : null}
        {props.projectMatch?.status === "suggested_only" ? (
          <p className="inbox-meta">AI запропонував проєкт, але точного зіставлення не знайдено.</p>
        ) : null}

        <label>
          Тип результату
          <select value={targetKind} onChange={(event) => setTargetKind(event.target.value as VoiceConfirmKind)}>
            <option value="task">Задача</option>
            <option value="note">Нотатка</option>
          </select>
        </label>

        <label>
          Назва
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Коротка назва"
            disabled={props.busy}
          />
        </label>

        <label>
          Деталі
          <textarea
            rows={4}
            value={details}
            onChange={(event) => setDetails(event.target.value)}
            placeholder="Що саме потрібно зробити або зберегти"
            disabled={props.busy}
          />
        </label>

        {targetKind === "task" ? (
          <>
            <label>
              Проєкт
              <select value={projectId} onChange={(event) => setProjectId(event.target.value)} disabled={props.busy}>
                <option value="">Без проєкту</option>
                {props.projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>

            <label>
              Тип задачі
              <select value={taskType} onChange={(event) => setTaskType(event.target.value as TaskType | "")}>
                <option value="">За замовчуванням</option>
                {TASK_TYPE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label>
              Важливість (1-5)
              <input
                type="number"
                min={1}
                max={5}
                step={1}
                value={importance}
                onChange={(event) => {
                  const value = event.target.value;
                  if (!value) {
                    setImportance("");
                    return;
                  }
                  const parsed = Number(value);
                  if (Number.isNaN(parsed)) {
                    setImportance("");
                    return;
                  }
                  setImportance(Math.max(1, Math.min(5, Math.round(parsed))));
                }}
              />
            </label>

            <label>
              Заплановано на
              <input
                type="datetime-local"
                value={scheduledForInput}
                onChange={(event) => setScheduledForInput(event.target.value)}
              />
            </label>

            <label>
              Дедлайн
              <input type="datetime-local" value={dueAtInput} onChange={(event) => setDueAtInput(event.target.value)} />
            </label>
          </>
        ) : null}

        <div className="modal-actions">
          <button type="button" onClick={props.onCancel} disabled={props.busy}>
            Скасувати
          </button>
          <button
            type="button"
            onClick={() =>
              props.onConfirm({
                targetKind,
                title: title.trim(),
                details: details.trim(),
                noteBody,
                projectId: projectId || null,
                taskType: taskType || null,
                importance: typeof importance === "number" ? importance : null,
                dueAt: localInputToIso(dueAtInput),
                scheduledFor: localInputToIso(scheduledForInput)
              })
            }
            disabled={submitDisabled}
          >
            {props.busy ? "Збереження..." : "Підтвердити"}
          </button>
        </div>
      </section>
    </div>
  );
}
