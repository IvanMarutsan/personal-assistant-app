export type TelegramAuthPayload = {
  initDataRaw: string;
};

export type AppSession = {
  token: string;
  expiresAt: string;
  userId: string;
};

export type InboxItem = {
  id: string;
  status: "new" | "triaged" | "discarded";
  source_type: "text" | "voice";
  source_channel: "telegram_bot" | "mini_app";
  raw_text: string | null;
  transcript_text: string | null;
  voice_file_id: string | null;
  captured_at: string;
  meta: Record<string, unknown>;
};

export type VoiceDetectedIntent = "task" | "note" | "worklog_candidate" | "meeting_candidate" | "reminder_candidate";
export type VoiceConfirmTargetKind = "task" | "note" | "worklog" | "calendar_event";
export type VoiceCandidateStatus = "pending" | "confirmed" | "discarded";

export type VoiceAiSuggestion = {
  detectedIntent: VoiceDetectedIntent;
  title: string;
  details: string;
  projectGuess: string | null;
  taskTypeGuess:
    | "communication"
    | "publishing"
    | "admin"
    | "planning"
    | "tech"
    | "content"
    | "meeting"
    | "review"
    | "deep_work"
    | "quick_communication"
    | "admin_operational"
    | "recurring_essential"
    | "personal_essential"
    | "someday"
    | null;
  importanceGuess: number | null;
  dueHint: string | null;
  datetimeHint: string | null;
  dueAtIso: string | null;
  scheduledForIso: string | null;
  confidence: number;
  reasoningSummary: string;
};

export type VoiceAiCandidate = VoiceAiSuggestion & {
  candidateId: string;
  status: VoiceCandidateStatus;
  resolvedAt: string | null;
  resolutionAction: "task" | "note" | "worklog" | "calendar_event" | "discard" | null;
};

export type ProjectItem = {
  id: string;
  name: string;
  status: "active" | "on_hold" | "archived";
  rank: number;
  aliases: string[];
};

export type NoteItem = {
  id: string;
  title: string | null;
  body: string;
  created_at: string;
  updated_at: string;
  project_id: string | null;
  projects?: { name: string } | { name: string }[] | null;
};

export type WorklogItem = {
  id: string;
  body: string;
  occurred_at: string;
  created_at: string;
  updated_at: string;
  project_id: string | null;
  source: string | null;
  projects?: { name: string } | { name: string }[] | null;
};

export type GoogleCalendarStatus = {
  connected: boolean;
  provider: "google";
  email: string | null;
  calendarId: string | null;
  selectedCalendarIds: string[];
  defaultCalendarId: string | null;
  defaultTaskListId: string | null;
  tasksScopeAvailable: boolean;
  tasksAccessState?: "usable" | "scope_missing" | "permission_denied" | "auth_expired" | "not_connected" | "unknown";
  tasksAccessError?: string | null;
  expiresAt: string | null;
};

export type GoogleCalendarListItem = {
  id: string;
  summary: string;
  description: string | null;
  primary: boolean;
  selected: boolean;
  default: boolean;
  accessRole: string | null;
  backgroundColor: string | null;
};

export type GoogleTaskListItem = {
  id: string;
  title: string;
  updated: string | null;
  isDefault: boolean;
};

export type GoogleIntegrationPreferences = {
  connected: boolean;
  calendars: GoogleCalendarListItem[];
  taskLists: GoogleTaskListItem[];
  selectedCalendarIds: string[];
  defaultCalendarId: string | null;
  defaultTaskListId: string | null;
  tasksScopeAvailable: boolean;
  tasksAccessState?: "usable" | "scope_missing" | "permission_denied" | "auth_expired" | "not_connected" | "unknown";
  tasksAccessError?: string | null;
};

export type GoogleCalendarEventItem = {
  id: string;
  title: string;
  description: string | null;
  status: string | null;
  htmlLink: string | null;
  startAt: string | null;
  endAt: string | null;
  timezone: string | null;
};


export type CalendarBlockItem = {
  id: string;
  title: string;
  details: string | null;
  start_at: string;
  end_at: string;
  timezone: string;
  source: "app" | "google";
  calendar_provider: string;
  provider_calendar_id?: string;
  provider_event_id: string | null;
  provider_event_url: string | null;
  provider_status: string | null;
  project_id: string | null;
  is_all_day: boolean;
  is_recurring?: boolean;
  recurrence_rule?: string | null;
  recurrence_timezone?: string | null;
  recurrence_parent_provider_event_id?: string | null;
  archived_at: string | null;
  projects?: { name: string } | { name: string }[] | null;
};

export type TriageAction = "task" | "note" | "worklog" | "discard";

export type TaskStatus = "planned" | "in_progress" | "blocked" | "done" | "cancelled";

export type TaskType =
  | "communication"
  | "publishing"
  | "admin"
  | "planning"
  | "tech"
  | "content"
  | "meeting"
  | "review"
  | "deep_work"
  | "quick_communication"
  | "admin_operational"
  | "recurring_essential"
  | "personal_essential"
  | "someday";

export type PlanningFlexibility = "essential" | "flexible";
export type RecurrenceFrequency = "daily" | "weekly" | "monthly";

export type TaskItem = {
  id: string;
  title: string;
  details?: string | null;
  task_type: TaskType;
  status: TaskStatus;
  last_moved_reason?: MoveReasonCode | null;
  cancel_reason_text?: string | null;
  calendar_provider?: string | null;
  calendar_provider_calendar_id?: string | null;
  calendar_event_id?: string | null;
  calendar_sync_mode?: "app_managed" | "manual" | null;
  calendar_sync_error?: string | null;
  google_task_provider?: string | null;
  google_task_list_id?: string | null;
  google_task_id?: string | null;
  google_task_sync_mode?: "app_managed" | "manual" | null;
  google_task_sync_error?: string | null;
  linked_calendar_event?: {
    provider: "google";
    provider_calendar_id?: string;
    provider_event_id: string;
    provider_event_url: string | null;
    title: string;
    starts_at: string;
    ends_at: string;
    timezone: string;
  } | null;
  linked_google_task?: {
    provider: "google_tasks";
    task_list_id: string;
    task_id: string;
  } | null;
  project_id: string | null;
  due_at: string | null;
  scheduled_for: string | null;
  estimated_minutes: number | null;
  planning_flexibility: PlanningFlexibility | null;
  is_recurring?: boolean;
  recurrence_rule?: string | null;
  recurrence_timezone?: string | null;
  is_protected_essential: boolean;
  projects?: { name: string } | { name: string }[] | null;
};

export type CreateTaskResult = {
  taskId: string;
  googleTaskSyncError: string | null;
  linkedGoogleTask: boolean;
  googleTaskSyncState: "linked" | "not_linked" | "sync_unavailable";
};

export type MoveReasonCode =
  | "reprioritized"
  | "urgent_interrupt"
  | "low_energy"
  | "waiting_response"
  | "waiting_on_external"
  | "underestimated"
  | "blocked_dependency"
  | "calendar_conflict"
  | "personal_issue"
  | "other";

export type PlanningRecommendation = {
  taskId?: string;
  title: string;
  reason: string;
  tier: "overdue" | "hard_today" | "due_today_unscheduled" | "protected_essential" | "high_importance" | "quick_comm_batch";
};

export type WorklogContextSummary = {
  count: number;
  withoutProjectCount: number;
  topProjects: Array<{ name: string; count: number }>;
  sourceCounts: Array<{ source: string; count: number }>;
};
export type WeeklyReviewItem = {
  taskId: string | null;
  title: string;
  reason: string;
};
export type WeeklyReviewSummary = {
  done: WeeklyReviewItem[];
  notDone: WeeklyReviewItem[];
  moved: WeeklyReviewItem[];
  shouldMove: WeeklyReviewItem[];
  shouldKill: WeeklyReviewItem[];
};
export type TaskCalendarInboundState =
  | {
      status: "manual" | "not_linked" | "healthy";
      message: string | null;
    }
  | {
      status: "changed";
      message: string;
      remoteScheduledFor: string;
      remoteEstimatedMinutes: number;
    }
  | {
      status: "missing" | "unsupported";
      message: string;
    };
export type TaskGoogleInboundState =
  | {
      status: "manual" | "not_linked" | "healthy";
      message: string | null;
    }
  | {
      status: "changed";
      message: string;
      remoteTitle: string;
      remoteDetails: string | null;
      remoteDueAt: string | null;
      remoteStatus: "planned" | "done";
    }
  | {
      status: "missing";
      message: string;
    };
export type TaskGoogleImportResult = {
  importedCount: number;
  updatedCount: number;
  unchangedCount: number;
  totalRemoteCount: number;
  listId: string | null;
};
export type PlanningSummary = {
  generatedAt: string;
  timezone: string;
  scopeType: "day" | "week";
  scopeDate: string;
  rulesVersion: string;
  whatNow: {
    primary: PlanningRecommendation | null;
    secondary: PlanningRecommendation[];
  };
  overload: {
    hasOverload: boolean;
    plannedTodayCount: number;
    dueTodayWithoutPlannedStartCount: number;
    backlogCount: number;
    overduePlannedCount: number;
    quickCommunicationOpenCount: number;
    quickCommunicationBatchingRecommended: boolean;
    protectedPendingCount: number;
    scheduledKnownEstimateMinutes: number;
    scheduledMissingEstimateCount: number;
    taskTypeSignals: string[];
    flags: Array<{ code: string; message: string }>;
  };
  essentialRisk: {
    protectedEssentialRisk: Array<{
      taskId: string;
      title: string;
      project: string | null;
      postponeCount: number;
      reason: string;
    }>;
    recurringEssentialRisk: Array<{
      taskId: string;
      title: string;
      project: string | null;
      postponeCount: number;
      reason: string;
    }>;
    squeezedOutRisk: Array<{
      taskId: string;
      title: string;
      project: string | null;
      postponeCount: number;
      reason: string;
    }>;
  };
  dailyReview: {
    completedTodayCount: number;
    movedTodayCount: number;
    cancelledTodayCount: number;
    protectedEssentialsMissedToday: number;
    topMovedReasons: Array<{ reason: string; count: number }>;
    worklogs: WorklogContextSummary;
  };
  weeklyReview: WeeklyReviewSummary | null;
  weekDays: PlanningConversationScopeDaySummary[];
  notableDeadlines: PlanningConversationDeadlineSummary[];
  appliedThresholds: {
    plannedTodayOverload: number;
    overdueOverload: number;
    quickCommunicationOverload: number;
    quickCommunicationBatching: number;
    highImportanceMin: number;
    protectedRiskPostponeCount: number;
    recurringRiskPostponeCount: number;
    squeezedOutPostponeCount: number;
  };
};

export type AiAdvisorSummary = {
  generatedAt: string;
  timezone: string;
  scopeType: "day" | "week";
  model: string | null;
  source: "ai" | "fallback_rules";
  fallbackReason: string | null;
  contextSnapshot: {
    scopeType: "day" | "week";
    scopeDate: string;
    currentLocalTime: string;
    quickCommunicationOpenCount: number;
    plannedTodayCount: number;
    dueTodayWithoutPlannedStartCount: number;
    backlogCount: number;
    overduePlannedCount: number;
    scheduledKnownEstimateMinutes: number;
    scheduledMissingEstimateCount: number;
    protectedPendingCount: number;
    recurringAtRiskCount: number;
    calendarDay: {
      connected: boolean;
      available: boolean;
      eventCount: number;
      busyMinutes: number | null;
      extraEventCount: number;
    };
    topMovedReasonsToday: Array<{ reason: string; count: number }>;
    dailyReview: {
      completedTodayCount: number;
      movedTodayCount: number;
      cancelledTodayCount: number;
      protectedEssentialsMissedToday: number;
    };
    worklogs: WorklogContextSummary;
    taskTypeSignals: string[];
    weekDays: PlanningConversationScopeDaySummary[];
    notableDeadlines: PlanningConversationDeadlineSummary[];
  };
  advisor: {
    whatMattersMostNow: string;
    suggestedNextAction: {
      taskId: string | null;
      title: string;
      reason: string;
    };
    suggestedDefer: {
      taskId: string | null;
      title: string;
      reason: string;
    };
    protectedEssentialsWarning: {
      hasWarning: boolean;
      message: string;
    };
    explanation: string;
    evidence: string[];
  };
};










export type PlanningConversationProposalStatus = "proposed" | "applied" | "dismissed" | "superseded";

export type PlanningConversationTaskPatch = {
  scheduled_for?: string | null;
  due_at?: string | null;
  estimated_minutes?: number | null;
};

export type PlanningConversationScopeType = "day" | "week";

export type PlanningConversationSession = {
  id: string;
  scopeType: PlanningConversationScopeType;
  scopeDate: string;
  status: "active" | "closed";
  createdAt: string;
  updatedAt: string;
};

export type PlanningConversationMessage = {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};

export type PlanningConversationTask = {
  id: string;
  title: string;
  details: string | null;
  taskType: TaskType;
  status: TaskStatus;
  importance: number;
  isProtectedEssential: boolean;
  projectId: string | null;
  projectName: string | null;
  dueAt: string | null;
  scheduledFor: string | null;
  estimatedMinutes: number | null;
  planningFlexibility: PlanningFlexibility | null;
};


export type PlanningConversationCalendarEvent = {
  id: string;
  title: string;
  startAt: string | null;
  endAt: string | null;
  isAllDay: boolean;
};

export type PlanningConversationCalendarContext = {
  connected: boolean;
  available: boolean;
  eventCount: number;
  busyMinutes: number | null;
  events: PlanningConversationCalendarEvent[];
  extraEventCount: number;
};

export type PlanningConversationWorklogContext = {
  count: number;
  withoutProjectCount: number;
  topProjects: Array<{ name: string; count: number }>;
  sourceCounts: Array<{ source: string; count: number }>;
};

export type PlanningConversationScopeDaySummary = {
  scopeDate: string;
  plannedCount: number;
  dueWithoutPlannedStartCount: number;
  scheduledKnownEstimateMinutes: number;
  scheduledMissingEstimateCount: number;
  calendarEventCount: number;
  calendarBusyMinutes: number | null;
  worklogCount: number;
  essentialScheduledCount: number;
  flexibleScheduledCount: number;
};

export type PlanningConversationDeadlineSummary = {
  taskId: string;
  title: string;
  projectName: string | null;
  dueAt: string;
};
export type PlanningConversationProposal = {
  id: string;
  sessionId: string;
  assistantMessageId: string | null;
  taskId: string;
  proposalType: "task_patch";
  payload: PlanningConversationTaskPatch;
  rationale: string | null;
  status: PlanningConversationProposalStatus;
  createdAt: string;
  updatedAt: string;
  task: PlanningConversationTask | null;
};

export type PlanningConversationState = {
  session: PlanningConversationSession;
  messages: PlanningConversationMessage[];
  proposals: PlanningConversationProposal[];
  latestAssistantMessageId: string | null;
  latestActionableAssistantMessageId: string | null;
  latestActionableProposalIds: string[];
  latestActionableProposalCount: number;
  scopeContext: {
    scopeType: PlanningConversationScopeType;
    timezone: string;
    scopeDate: string;
    scopeStartIso: string;
    scopeEndIso: string;
    plannedCount: number;
    dueWithoutPlannedStartCount: number;
    backlogCount: number;
    scheduledKnownEstimateMinutes: number;
    scheduledMissingEstimateCount: number;
    calendar: PlanningConversationCalendarContext;
    worklogs: PlanningConversationWorklogContext;
    weekDays: PlanningConversationScopeDaySummary[];
    notableDeadlines: PlanningConversationDeadlineSummary[];
  };
};























