export const SETTINGS_STORAGE_KEY = "issue-estimator-settings-v1";

export const OPENROUTER_MODEL_OPTIONS = [
  { value: "openai/gpt-5", label: "OpenAI GPT-5" },
  { value: "x-ai/grok-code-fast-1", label: "xAI Grok Code Fast 1" },
  { value: "anthropic/claude-sonnet-4.5", label: "Anthropic Claude Sonnet 4.5" },
] as const;

export const OPENROUTER_KEY_DOC_URL = "https://openrouter.ai/settings/keys";
export const GITHUB_TOKEN_DOC_URL = "https://github.com/settings/tokens";

export type OpenRouterModel = (typeof OPENROUTER_MODEL_OPTIONS)[number]["value"];

export type IssueEstimatorSettings = {
  openRouterKey: string;
  githubToken: string;
  model: OpenRouterModel;
  hourlyRate: string;
};

export const DEFAULT_SETTINGS: IssueEstimatorSettings = {
  openRouterKey: "",
  githubToken: "",
  model: OPENROUTER_MODEL_OPTIONS[0].value,
  hourlyRate: "",
};

const MODEL_VALUES = new Set(
  OPENROUTER_MODEL_OPTIONS.map((option) => option.value)
);

function sanitizeString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeSettings(
  settings: Partial<IssueEstimatorSettings> | null | undefined
): IssueEstimatorSettings {
  return {
    openRouterKey: sanitizeString(settings?.openRouterKey) || DEFAULT_SETTINGS.openRouterKey,
    githubToken: sanitizeString(settings?.githubToken) || DEFAULT_SETTINGS.githubToken,
    model:
      typeof settings?.model === "string" && MODEL_VALUES.has(settings.model as OpenRouterModel)
        ? (settings.model as OpenRouterModel)
        : DEFAULT_SETTINGS.model,
    hourlyRate: sanitizeString(settings?.hourlyRate) || DEFAULT_SETTINGS.hourlyRate,
  };
}

export function loadSettingsFromStorage(): IssueEstimatorSettings | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<IssueEstimatorSettings>;
    return normalizeSettings(parsed);
  } catch {
    return null;
  }
}

export function saveSettingsToStorage(settings: Partial<IssueEstimatorSettings>): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  const normalized = normalizeSettings(settings);

  try {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(normalized));
    return true;
  } catch {
    // Ignore storage errors (e.g. Safari private mode)
    return false;
  }
}
