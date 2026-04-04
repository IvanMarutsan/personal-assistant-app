import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { formatTaskDateTime, formatTaskEstimate } from "../lib/taskTiming";
import type {
  PlanningConversationProposal,
  PlanningConversationScopeType,
  PlanningConversationState,
  PlanningConversationTaskPatch
} from "../types/api";

type PlanningConversationModalProps = {
  open: boolean;
  scopeType: PlanningConversationScopeType;
  scopeDate: string;
  state: PlanningConversationState | null;
  busy: boolean;
  actingProposalId: string | null;
  errorMessage: string | null;
  onClose: () => void;
  onRetryLoad: () => void;
  onSend: (message: string) => void;
  onTranscribeVoice: (file: File) => Promise<string>;
  onApplyProposal: (proposalId: string) => void;
  onDismissProposal: (proposalId: string) => void;
  onApplyAllLatest: (assistantMessageId: string) => void;
  onDismissAllLatest: (assistantMessageId: string) => void;
};

type VoiceState = "idle" | "recording" | "transcribing";

function formatDayScopeDate(scopeDate: string): string {
  const parsed = new Date(`${scopeDate}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return scopeDate;
  return new Intl.DateTimeFormat("uk-UA", { dateStyle: "full" }).format(parsed);
}

function formatWeekScopeDate(scopeDate: string): string {
  const start = new Date(`${scopeDate}T12:00:00`);
  if (Number.isNaN(start.getTime())) return scopeDate;
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const formatter = new Intl.DateTimeFormat("uk-UA", { day: "numeric", month: "long" });
  return `${formatter.format(start)} - ${formatter.format(end)}`;
}

function formatScopeLabel(scopeType: PlanningConversationScopeType, scopeDate: string): string {
  return scopeType === "week" ? formatWeekScopeDate(scopeDate) : formatDayScopeDate(scopeDate);
}

function scopeHeading(scopeType: PlanningConversationScopeType): string {
  return scopeType === "week" ? "Обговорити тиждень" : "Обговорити план";
}

function scopeSubtitle(scopeType: PlanningConversationScopeType, scopeDate: string): string {
  return scopeType === "week" ? `Тиждень ${formatScopeLabel(scopeType, scopeDate)}` : `План на ${formatScopeLabel(scopeType, scopeDate)}`;
}

function proposalStatusLabel(
  proposal: PlanningConversationProposal,
  isInLatestActionableSet: boolean
): string {
  if (proposal.status === "applied") return "Застосовано";
  if (proposal.status === "dismissed") return "Відхилено";
  if (proposal.status === "superseded") return "Замінено новішою пропозицією";
  if (!isInLatestActionableSet) return "Неактивний набір пропозицій";
  return "Очікує рішення";
}

function patchSummary(patch: PlanningConversationTaskPatch): string {
  const parts: string[] = [];

  if (Object.prototype.hasOwnProperty.call(patch, "scheduled_for")) {
    parts.push(
      patch.scheduled_for
        ? `Планований старт: ${formatTaskDateTime(new Date(patch.scheduled_for))}`
        : "Повернути в беклог"
    );
  }

  if (Object.prototype.hasOwnProperty.call(patch, "due_at")) {
    parts.push(
      patch.due_at ? `Дедлайн: ${formatTaskDateTime(new Date(patch.due_at))}` : "Очистити дедлайн"
    );
  }

  if (Object.prototype.hasOwnProperty.call(patch, "estimated_minutes")) {
    parts.push(
      patch.estimated_minutes
        ? `Оцінка: ${formatTaskEstimate(patch.estimated_minutes)}`
        : "Очистити оцінку"
    );
  }

  return parts.join(" · ");
}

function proposalLead(patch: PlanningConversationTaskPatch): string {
  if (Object.prototype.hasOwnProperty.call(patch, "scheduled_for") && patch.scheduled_for === null) {
    return "Повернути в беклог";
  }
  if (Object.prototype.hasOwnProperty.call(patch, "scheduled_for") && patch.scheduled_for) {
    return "Оновити планований старт";
  }
  if (Object.prototype.hasOwnProperty.call(patch, "due_at")) {
    return patch.due_at ? "Оновити дедлайн" : "Очистити дедлайн";
  }
  if (Object.prototype.hasOwnProperty.call(patch, "estimated_minutes")) {
    return patch.estimated_minutes ? "Оновити оцінку" : "Очистити оцінку";
  }
  return "Запропонована зміна";
}

function voiceStatusLabel(state: VoiceState): string | null {
  if (state === "recording") return "Йде запис голосу...";
  if (state === "transcribing") return "Розпізнаємо голос...";
  return null;
}

function formatWeekDaySummary(scopeDate: string): string {
  const parsed = new Date(`${scopeDate}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return scopeDate;
  return new Intl.DateTimeFormat("uk-UA", { weekday: "short", day: "numeric", month: "short" }).format(parsed);
}

export function PlanningConversationModal(props: PlanningConversationModalProps) {
  const [draft, setDraft] = useState("");
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const proposalsByMessageId = useMemo(() => {
    const map = new Map<string, PlanningConversationProposal[]>();
    for (const proposal of props.state?.proposals ?? []) {
      const key = proposal.assistantMessageId ?? "__none__";
      const bucket = map.get(key) ?? [];
      bucket.push(proposal);
      map.set(key, bucket);
    }
    return map;
  }, [props.state?.proposals]);

  function stopRecordingTracks() {
    recorderRef.current = null;
    chunksRef.current = [];
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }
  }

  useEffect(() => {
    if (!props.open) {
      stopRecordingTracks();
      setVoiceState("idle");
      setVoiceError(null);
    }
  }, [props.open]);

  useEffect(() => {
    return () => {
      stopRecordingTracks();
    };
  }, []);

  function insertTranscript(transcript: string) {
    const cleaned = transcript.trim();
    if (!cleaned) return;
    setDraft((current) => {
      if (!current.trim()) return cleaned;
      return current.endsWith("\n") ? `${current}${cleaned}` : `${current}\n${cleaned}`;
    });
  }

  async function transcribeVoiceFile(file: File) {
    setVoiceError(null);
    setVoiceState("transcribing");
    try {
      const transcript = await props.onTranscribeVoice(file);
      insertTranscript(transcript);
    } catch (error) {
      setVoiceError(error instanceof Error ? error.message : "Не вдалося розпізнати голос. Спробуй ще раз.");
    } finally {
      setVoiceState("idle");
    }
  }

  async function startVoiceRecording() {
    if (props.busy || voiceState === "transcribing") return;

    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      fileInputRef.current?.click();
      return;
    }

    try {
      setVoiceError(null);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];

      const preferredMimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : "";

      const recorder = preferredMimeType ? new MediaRecorder(stream, { mimeType: preferredMimeType }) : new MediaRecorder(stream);
      recorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onerror = () => {
        stopRecordingTracks();
        setVoiceState("idle");
        setVoiceError("Не вдалося записати голос. Спробуй ще раз.");
      };

      recorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        stopRecordingTracks();
        if (blob.size === 0) {
          setVoiceState("idle");
          setVoiceError("Не вдалося отримати запис. Спробуй ще раз.");
          return;
        }
        const file = new File([blob], "planning-voice.webm", { type: blob.type || "audio/webm" });
        await transcribeVoiceFile(file);
      };

      recorder.start();
      setVoiceState("recording");
    } catch {
      stopRecordingTracks();
      fileInputRef.current?.click();
    }
  }

  function stopVoiceRecording() {
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      setVoiceState("transcribing");
      recorderRef.current.stop();
    }
  }

  async function handleAudioFileSelected(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (!file) return;
    await transcribeVoiceFile(file);
  }

  if (!props.open) return null;

  const state = props.state;
  const latestActionableAssistantMessageId = state?.latestActionableAssistantMessageId ?? null;
  const isInitialLoading = !state && props.busy && !props.errorMessage;
  const hasInitialLoadError = !state && !!props.errorMessage && !props.busy;
  const effectiveScopeType = state?.session.scopeType ?? props.scopeType;
  const effectiveScopeDate = state?.session.scopeDate ?? props.scopeDate;
  const statusScopeDate = formatScopeLabel(effectiveScopeType, effectiveScopeDate);
  const voiceStatus = voiceStatusLabel(voiceState);
  const scopeContext = state?.scopeContext ?? null;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={props.onClose}>
      <section className="modal-card planning-modal" onClick={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <h3>{scopeHeading(effectiveScopeType)}</h3>
          <p className="modal-task-title">{scopeSubtitle(effectiveScopeType, effectiveScopeDate)}</p>
        </header>

        <div className="modal-body planning-body">
          {isInitialLoading ? <p className="empty-note">Завантажуємо розмову про план...</p> : null}

          {hasInitialLoadError ? (
            <section className="planning-summary">
              <p className="error-note">{props.errorMessage ?? "Не вдалося завантажити обговорення плану."}</p>
              <div className="inbox-actions">
                <button type="button" onClick={props.onRetryLoad} disabled={props.busy}>
                  Спробувати ще раз
                </button>
              </div>
            </section>
          ) : null}

          {state && scopeContext ? (
            <>
              <section className="planning-summary">
                <p className="inbox-meta">
                  У плані: {scopeContext.plannedCount} · Дедлайни без плану: {scopeContext.dueWithoutPlannedStartCount} · Беклог: {scopeContext.backlogCount}
                </p>
                <p className="inbox-meta">
                  Відоме навантаження: {formatTaskEstimate(scopeContext.scheduledKnownEstimateMinutes) ?? "немає"} · Без оцінки: {scopeContext.scheduledMissingEstimateCount}
                </p>
                {scopeContext.calendar.available ? (
                  <p className="inbox-meta">
                    У календарі: {scopeContext.calendar.eventCount} · Зайнято: {formatTaskEstimate(scopeContext.calendar.busyMinutes) ?? `${scopeContext.calendar.busyMinutes ?? 0} хв`}
                    {scopeContext.calendar.extraEventCount > 0 ? ` · Ще подій: ${scopeContext.calendar.extraEventCount}` : ""}
                  </p>
                ) : null}
                {scopeContext.worklogs.count > 0 ? (
                  <p className="inbox-meta">Контекстні записи: {scopeContext.worklogs.count} · Без проєкту: {scopeContext.worklogs.withoutProjectCount}</p>
                ) : null}
                {effectiveScopeType === "week" && scopeContext.weekDays.length > 0 ? (
                  <ul className="assistant-secondary">
                    {scopeContext.weekDays.map((day) => (
                      <li key={day.scopeDate}>
                        <strong>{formatWeekDaySummary(day.scopeDate)}</strong>
                        <span>
                          {` · План: ${day.plannedCount} · Дедлайни без плану: ${day.dueWithoutPlannedStartCount} · Оцінено: ${formatTaskEstimate(day.scheduledKnownEstimateMinutes) ?? "немає"}`}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {scopeContext.notableDeadlines.length > 0 ? (
                  <p className="inbox-meta">
                    Дедлайни в межах {effectiveScopeType === "week" ? "тижня" : "дня"}: {scopeContext.notableDeadlines.slice(0, 4).map((item) => item.title).join(" · ")}
                  </p>
                ) : null}
                {state.latestActionableProposalCount > 0 ? (
                  <p className="inbox-meta">Активний лише найновіший набір пропозицій.</p>
                ) : (
                  <p className="inbox-meta">Зараз немає активного набору пропозицій.</p>
                )}
              </section>

              {props.errorMessage ? <p className="error-note">{props.errorMessage}</p> : null}

              <div className="planning-thread">
                {state.messages.length === 0 ? (
                  <p className="empty-note">
                    {effectiveScopeType === "week"
                      ? "Напиши, що саме хочеш переглянути в плані цього тижня."
                      : "Напиши, що саме хочеш переглянути в плані цього дня."}
                  </p>
                ) : (
                  state.messages.map((message) => {
                    const linkedProposals = proposalsByMessageId.get(message.id) ?? [];
                    const isLatestActionableMessage =
                      message.id === latestActionableAssistantMessageId &&
                      linkedProposals.some((proposal) => proposal.status === "proposed");

                    return (
                      <article
                        key={message.id}
                        className={`planning-message planning-message--${message.role}`}
                      >
                        <p className="planning-message-role">
                          {message.role === "user" ? "Ти" : "Планувальник"}
                        </p>
                        <p className="planning-message-content">{message.content}</p>

                        {message.role === "assistant" &&
                        linkedProposals.length === 0 &&
                        state.latestAssistantMessageId === message.id ? (
                          <p className="empty-note">Пропозицій змін зараз немає.</p>
                        ) : null}

                        {linkedProposals.length > 0 ? (
                          <div className="planning-proposals">
                            {isLatestActionableMessage ? (
                              <div className="inbox-actions planning-bulk-actions">
                                <button
                                  type="button"
                                  onClick={() => props.onApplyAllLatest(message.id)}
                                  disabled={props.busy}
                                >
                                  {props.busy ? "Застосування..." : "Застосувати все"}
                                </button>
                                <button
                                  type="button"
                                  className="ghost"
                                  onClick={() => props.onDismissAllLatest(message.id)}
                                  disabled={props.busy}
                                >
                                  Відхилити все
                                </button>
                              </div>
                            ) : null}

                            {linkedProposals.map((proposal) => {
                              const isActing = props.actingProposalId === proposal.id;
                              const isActionable =
                                proposal.status === "proposed" &&
                                proposal.assistantMessageId === latestActionableAssistantMessageId;

                              return (
                                <div key={proposal.id} className="planning-proposal-card">
                                  <p className="assistant-title">{proposalLead(proposal.payload)}</p>
                                  <p className="planning-proposal-task">{proposal.task?.title ?? "Задача"}</p>
                                  <p className="inbox-meta">{patchSummary(proposal.payload)}</p>
                                  {proposal.rationale ? <p className="inbox-meta">{proposal.rationale}</p> : null}
                                  <p className="planning-proposal-status">
                                    {proposalStatusLabel(proposal, isActionable)}
                                  </p>
                                  {isActionable ? (
                                    <div className="inbox-actions">
                                      <button
                                        type="button"
                                        onClick={() => props.onApplyProposal(proposal.id)}
                                        disabled={props.busy || isActing}
                                      >
                                        {isActing ? "Застосування..." : "Застосувати"}
                                      </button>
                                      <button
                                        type="button"
                                        className="ghost"
                                        onClick={() => props.onDismissProposal(proposal.id)}
                                        disabled={props.busy || isActing}
                                      >
                                        Відхилити
                                      </button>
                                    </div>
                                  ) : null}
                                </div>
                              );
                            })}
                          </div>
                        ) : null}
                      </article>
                    );
                  })
                )}
              </div>
            </>
          ) : null}
        </div>

        <footer className="modal-footer">
          {state ? (
            <>
              <label className="planning-compose">
                Коментар до плану
                <textarea
                  rows={3}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder={effectiveScopeType === "week" ? "Наприклад: середа перевантажена, навчання можна посунути на п’ятницю" : "Наприклад: я не встигну все сьогодні, навчання можна на завтра"}
                  disabled={props.busy || voiceState === "transcribing"}
                />
              </label>
              <input
                ref={fileInputRef}
                type="file"
                accept="audio/*"
                capture="user"
                className="planning-voice-input"
                onChange={(event) => {
                  void handleAudioFileSelected(event);
                }}
              />
              <div className="planning-compose-tools">
                <div className="inbox-actions">
                  {voiceState === "recording" ? (
                    <button type="button" className="ghost" onClick={stopVoiceRecording} disabled={props.busy}>
                      Зупинити запис
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => {
                        void startVoiceRecording();
                      }}
                      disabled={props.busy || voiceState === "transcribing"}
                    >
                      {voiceState === "transcribing" ? "Розпізнавання..." : "Голос"}
                    </button>
                  )}
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={props.busy || voiceState === "recording" || voiceState === "transcribing"}
                  >
                    Аудіофайл
                  </button>
                </div>
                {voiceStatus ? <p className="inbox-meta planning-voice-status">{voiceStatus}</p> : null}
                {voiceError ? <p className="error-note">{voiceError}</p> : null}
              </div>
              <div className="modal-actions">
                <button type="button" className="ghost" onClick={props.onClose} disabled={props.busy}>
                  Закрити
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const value = draft.trim();
                    if (!value || props.busy || voiceState === "transcribing") return;
                    props.onSend(value);
                    setDraft("");
                    setVoiceError(null);
                  }}
                  disabled={props.busy || voiceState === "transcribing" || !draft.trim()}
                >
                  {props.busy ? "Надсилання..." : "Надіслати"}
                </button>
              </div>
            </>
          ) : (
            <div className="modal-actions">
              <button type="button" className="ghost" onClick={props.onClose} disabled={props.busy && isInitialLoading}>
                Закрити
              </button>
            </div>
          )}
        </footer>
      </section>
    </div>
  );
}
