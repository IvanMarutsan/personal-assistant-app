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

export type VoiceDetectedIntent = "task" | "note" | "meeting_candidate" | "reminder_candidate";

export type VoiceAiSuggestion = {
  detectedIntent: VoiceDetectedIntent;
  title: string;
  details: string;
  projectGuess: string | null;
  taskTypeGuess:
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

export type ProjectItem = {
  id: string;
  name: string;
  status: "active" | "on_hold" | "archived";
  rank: number;
};

export type TriageAction = "task" | "note" | "discard";

export type TaskStatus = "planned" | "in_progress" | "blocked" | "done" | "cancelled";

export type TaskType =
  | "deep_work"
  | "quick_communication"
  | "admin_operational"
  | "recurring_essential"
  | "personal_essential"
  | "someday";

export type TaskItem = {
  id: string;
  title: string;
  task_type: TaskType;
  status: TaskStatus;
  project_id: string | null;
  due_at: string | null;
  scheduled_for: string | null;
  is_protected_essential: boolean;
  projects?: { name: string } | { name: string }[] | null;
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
  tier: "overdue" | "hard_today" | "protected_essential" | "high_importance" | "quick_comm_batch";
};

export type PlanningSummary = {
  generatedAt: string;
  timezone: string;
  rulesVersion: string;
  whatNow: {
    primary: PlanningRecommendation | null;
    secondary: PlanningRecommendation[];
  };
  overload: {
    hasOverload: boolean;
    plannedTodayCount: number;
    overduePlannedCount: number;
    quickCommunicationOpenCount: number;
    quickCommunicationBatchingRecommended: boolean;
    protectedPendingCount: number;
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
  };
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
  model: string | null;
  source: "ai" | "fallback_rules";
  fallbackReason: string | null;
  contextSnapshot: {
    currentLocalTime: string;
    quickCommunicationOpenCount: number;
    plannedTodayCount: number;
    overduePlannedCount: number;
    protectedPendingCount: number;
    recurringAtRiskCount: number;
    topMovedReasonsToday: Array<{ reason: string; count: number }>;
    dailyReview: {
      completedTodayCount: number;
      movedTodayCount: number;
      cancelledTodayCount: number;
      protectedEssentialsMissedToday: number;
    };
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
