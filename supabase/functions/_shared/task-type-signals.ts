export type PlanningTaskType =
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

type SignalTask = {
  task_type?: PlanningTaskType | null;
};

type TaskTypeBucket =
  | "communication"
  | "admin"
  | "meeting"
  | "content"
  | "planning_review"
  | "focus"
  | "essential"
  | "someday"
  | "other";

export type TaskTypeSignalSummary = {
  total: number;
  communicationCount: number;
  adminCount: number;
  meetingCount: number;
  contentCount: number;
  planningReviewCount: number;
  focusCount: number;
  essentialCount: number;
  reactiveCount: number;
  distinctBucketCount: number;
  signals: string[];
};

function toBucket(taskType?: PlanningTaskType | null): TaskTypeBucket {
  switch (taskType) {
    case "communication":
    case "quick_communication":
      return "communication";
    case "admin":
    case "admin_operational":
      return "admin";
    case "meeting":
      return "meeting";
    case "publishing":
    case "content":
      return "content";
    case "planning":
    case "review":
      return "planning_review";
    case "tech":
    case "deep_work":
      return "focus";
    case "recurring_essential":
    case "personal_essential":
      return "essential";
    case "someday":
      return "someday";
    default:
      return "other";
  }
}

function countBucket(tasks: SignalTask[], bucket: TaskTypeBucket): number {
  return tasks.filter((task) => toBucket(task.task_type) === bucket).length;
}

export function summarizeTaskTypeSignals(
  tasks: SignalTask[],
  scopeType: "day" | "week"
): TaskTypeSignalSummary {
  const total = tasks.length;
  const communicationCount = countBucket(tasks, "communication");
  const adminCount = countBucket(tasks, "admin");
  const meetingCount = countBucket(tasks, "meeting");
  const contentCount = countBucket(tasks, "content");
  const planningReviewCount = countBucket(tasks, "planning_review");
  const focusCount = countBucket(tasks, "focus");
  const essentialCount = countBucket(tasks, "essential");
  const reactiveCount = communicationCount + adminCount + meetingCount;
  const distinctBucketCount = new Set(
    tasks
      .map((task) => toBucket(task.task_type))
      .filter((bucket) => bucket !== "other")
  ).size;

  const signals: string[] = [];

  if (communicationCount >= 3 || (total >= 4 && communicationCount >= 2 && communicationCount / total >= 0.4)) {
    signals.push(
      scopeType === "day"
        ? "У дні помітно багато комунікаційних задач, тож увага може розсипатись на дрібні відповіді."
        : "Тиждень помітно тягне в комунікацію, тож частина фокусу може йти в реактивні відповіді."
    );
  }

  if (adminCount >= 3 || (total >= 4 && adminCount >= 2 && adminCount / total >= 0.4)) {
    signals.push(
      scopeType === "day"
        ? "У дні накопичилось багато адміністративних задач, тож корисно не змішувати їх з усім іншим."
        : "Тиждень має помітний адмін-нахил, тож важливо не дати cleanup-задачам забрати весь ресурс."
    );
  }

  if (meetingCount >= 2) {
    signals.push(
      scopeType === "day"
        ? "У дні вже є кілька зустрічних задач, тож ручного фокусу залишиться менше."
        : "У тижні багато зустрічних задач, тож дні з власною роботою краще берегти окремо."
    );
  }

  if (contentCount >= 3 || (total >= 4 && contentCount >= 2 && contentCount / total >= 0.45)) {
    signals.push(
      scopeType === "day"
        ? "У дні зібрано помітний блок контенту або публікацій, тож його краще тримати більш цілісно."
        : "У тижні є виразний кластер контенту або публікацій, тож варто тримати його окремим блоком."
    );
  }

  if (scopeType === "week" && total >= 6 && planningReviewCount === 0) {
    signals.push("У тижні майже не видно задач на планування чи огляд, тож ручний review краще не пропускати.");
  }

  if (scopeType === "day" && total >= 5 && reactiveCount >= 3 && distinctBucketCount >= 4) {
    signals.push("У дні намішано забагато різних типів задач, тож він може бути фрагментованим.");
  }

  return {
    total,
    communicationCount,
    adminCount,
    meetingCount,
    contentCount,
    planningReviewCount,
    focusCount,
    essentialCount,
    reactiveCount,
    distinctBucketCount,
    signals
  };
}

export function taskTypeReasonLabel(taskType?: PlanningTaskType | null): string | null {
  switch (toBucket(taskType)) {
    case "communication":
      return "комунікаційний тип";
    case "admin":
      return "адмін-тип";
    case "meeting":
      return "зустрічний тип";
    case "content":
      return "контентний тип";
    case "planning_review":
      return "планувальний тип";
    case "focus":
      return "технічний або фокусний тип";
    case "essential":
      return "важливий регулярний тип";
    case "someday":
      return "слабко пріоритизований тип";
    default:
      return null;
  }
}
