import { useMemo, useState } from "react";
import { formatTaskDateTime, formatTaskEstimate } from "../lib/taskTiming";
import type {
  PlanningConversationProposal,
  PlanningConversationState,
  PlanningConversationTaskPatch
} from "../types/api";

type PlanningConversationModalProps = {
  open: boolean;
  scopeDate: string;
  state: PlanningConversationState | null;
  busy: boolean;
  actingProposalId: string | null;
  errorMessage: string | null;
  onClose: () => void;
  onRetryLoad: () => void;
  onSend: (message: string) => void;
  onApplyProposal: (proposalId: string) => void;
  onDismissProposal: (proposalId: string) => void;
  onApplyAllLatest: (assistantMessageId: string) => void;
  onDismissAllLatest: (assistantMessageId: string) => void;
};

function formatScopeDate(scopeDate: string): string {
  const parsed = new Date(`${scopeDate}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return scopeDate;
  return new Intl.DateTimeFormat("uk-UA", { dateStyle: "full" }).format(parsed);
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

export function PlanningConversationModal(props: PlanningConversationModalProps) {
  const [draft, setDraft] = useState("");

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

  if (!props.open) return null;

  const state = props.state;
  const latestActionableAssistantMessageId = state?.latestActionableAssistantMessageId ?? null;
  const isInitialLoading = !state && props.busy && !props.errorMessage;
  const hasInitialLoadError = !state && !!props.errorMessage && !props.busy;
  const isReady = !!state;
  const statusScopeDate = formatScopeDate(state?.session.scopeDate ?? props.scopeDate);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={props.onClose}>
      <section className="modal-card planning-modal" onClick={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <h3>Обговорити план</h3>
          <p className="modal-task-title">План на {statusScopeDate}</p>
        </header>

        <div className="modal-body planning-body">
          {isInitialLoading ? (
            <p className="empty-note">Завантажуємо розмову про план...</p>
          ) : null}

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

          {state ? (
            <>
              <section className="planning-summary">
                <p className="inbox-meta">
                  У плані: {state.dayContext.plannedTodayCount} · Дедлайни без плану: {state.dayContext.dueTodayWithoutPlannedStartCount} · Беклог: {state.dayContext.backlogCount}
                </p>
                <p className="inbox-meta">
                  Відоме навантаження: {formatTaskEstimate(state.dayContext.scheduledKnownEstimateMinutes) ?? "немає"} · Без оцінки: {state.dayContext.scheduledMissingEstimateCount}
                </p>
                {state.latestActionableProposalCount > 0 ? (
                  <p className="inbox-meta">Активний лише найновіший набір пропозицій.</p>
                ) : (
                  <p className="inbox-meta">Зараз немає активного набору пропозицій.</p>
                )}
              </section>

              {props.errorMessage ? <p className="error-note">{props.errorMessage}</p> : null}

              <div className="planning-thread">
                {state.messages.length === 0 ? (
                  <p className="empty-note">Напиши, що саме хочеш переглянути в плані цього дня.</p>
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
                  placeholder="Наприклад: я не встигну все сьогодні, навчання можна на завтра"
                  disabled={props.busy}
                />
              </label>
              <div className="modal-actions">
                <button type="button" className="ghost" onClick={props.onClose} disabled={props.busy}>
                  Закрити
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const value = draft.trim();
                    if (!value || props.busy) return;
                    props.onSend(value);
                    setDraft("");
                  }}
                  disabled={props.busy || !draft.trim()}
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
