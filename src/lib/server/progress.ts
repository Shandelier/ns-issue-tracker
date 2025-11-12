type StageDefaults = {
  label: string;
  hint?: string;
  value: number;
};

export type ProgressStage =
  | "pending"
  | "repo_tree"
  | "fetching_issues"
  | "collecting_context"
  | "preparing_prompt"
  | "calling_openrouter"
  | "parsing_response"
  | "complete"
  | "error";

export type ProgressOverrides = {
  label?: string;
  hint?: string;
  message?: string;
  value?: number;
  error?: string;
  processedCount?: number;
  totalCount?: number;
};

export type ProgressSnapshot = {
  id: string;
  stage: ProgressStage;
  label: string;
  hint?: string;
  message?: string;
  value: number;
  startedAt: number;
  updatedAt: number;
  error?: string;
  processedCount?: number;
  totalCount?: number;
};

const STAGE_META: Record<ProgressStage, StageDefaults> = {
  pending: {
    label: "Preparing request",
    hint: "Setting up the estimation job.",
    value: 0.05,
  },
  repo_tree: {
    label: "Loading repository tree",
    hint: "Fetching repository files and suggested paths.",
    value: 0.35,
  },
  fetching_issues: {
    label: "Fetching GitHub issues",
    hint: "Retrieving the latest open issues from GitHub.",
    value: 0.2,
  },
  collecting_context: {
    label: "Collecting repository context",
    hint: "Gathering selected files and metadata.",
    value: 0.4,
  },
  preparing_prompt: {
    label: "Preparing LLM prompt",
    hint: "Compiling issue summaries and context.",
    value: 0.55,
  },
  calling_openrouter: {
    label: "Waiting on OpenRouter",
    hint: "OpenRouter is generating estimates.",
    value: 0.8,
  },
  parsing_response: {
    label: "Processing OpenRouter result",
    hint: "Formatting the response from OpenRouter.",
    value: 0.92,
  },
  complete: {
    label: "Request complete",
    hint: "Estimates are ready.",
    value: 1,
  },
  error: {
    label: "Request failed",
    hint: "Check the error message below.",
    value: 1,
  },
};

const progressStore = new Map<string, ProgressSnapshot>();
const cleanupTimers = new Map<string, NodeJS.Timeout>();

const CLEANUP_DELAY_MS = 30_000;

function clampValue(value: number) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function sanitizeCount(value: number | undefined): number | undefined {
  if (!Number.isFinite(value)) {
    return undefined;
  }
  const normalized = Math.max(0, Math.trunc(value));
  return normalized;
}

function scheduleCleanup(id: string, stage: ProgressStage) {
  const existing = cleanupTimers.get(id);
  if (existing) {
    clearTimeout(existing);
    cleanupTimers.delete(id);
  }

  if (stage === "complete" || stage === "error") {
    const timer = setTimeout(() => {
      progressStore.delete(id);
      cleanupTimers.delete(id);
    }, CLEANUP_DELAY_MS);
    cleanupTimers.set(id, timer);
  }
}

export function setProgressStage(
  id: string,
  stage: ProgressStage,
  overrides: ProgressOverrides = {}
): ProgressSnapshot | null {
  if (!id) return null;

  const defaults = STAGE_META[stage];
  if (!defaults) {
    throw new Error(`Unknown progress stage: ${stage}`);
  }

  const now = Date.now();
  const previous = progressStore.get(id);
  const startedAt = previous?.startedAt ?? now;

  const message = overrides.message ?? (stage === "error" ? overrides.error : undefined);
  const error = stage === "error" ? (overrides.error ?? overrides.message ?? previous?.error) : undefined;
  const processedCount = sanitizeCount(
    overrides.processedCount ?? previous?.processedCount
  );
  const totalCount = sanitizeCount(
    overrides.totalCount ?? previous?.totalCount
  );

  const snapshot: ProgressSnapshot = {
    id,
    stage,
    label: overrides.label ?? defaults.label,
    hint: overrides.hint ?? defaults.hint,
    message,
    value: clampValue(overrides.value ?? defaults.value),
    startedAt,
    updatedAt: now,
    ...(error ? { error } : {}),
    ...(typeof processedCount === "number" ? { processedCount } : {}),
    ...(typeof totalCount === "number" ? { totalCount } : {}),
  };

  progressStore.set(id, snapshot);
  scheduleCleanup(id, stage);
  return snapshot;
}

export function getProgressSnapshot(id: string): ProgressSnapshot | null {
  return progressStore.get(id) ?? null;
}

export function removeProgress(id: string) {
  progressStore.delete(id);
  const timer = cleanupTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    cleanupTimers.delete(id);
  }
}
