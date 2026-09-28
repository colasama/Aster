/**
 * Persists the Operator's provider credentials on this device. The API key is stored
 * in plain local storage just like other desktop agent tools; it never enters logs.
 */
export interface AgentProviderSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  supportsImages: boolean;
}

export const AI_PROVIDER_STORAGE_KEY = "aster.aiProvider";

export const DEFAULT_PROVIDER_SETTINGS: AgentProviderSettings = {
  baseUrl: "https://88996api.cloud/v1",
  apiKey: "",
  model: "deepseek-v4-flash-0731",
  supportsImages: false,
};

export function loadAgentProviderSettings(): AgentProviderSettings {
  if (typeof window === "undefined") return { ...DEFAULT_PROVIDER_SETTINGS };
  try {
    const stored = window.localStorage.getItem(AI_PROVIDER_STORAGE_KEY);
    if (!stored) return { ...DEFAULT_PROVIDER_SETTINGS };
    const value = JSON.parse(stored) as Partial<AgentProviderSettings>;
    return {
      baseUrl: nonEmptyString(value.baseUrl, DEFAULT_PROVIDER_SETTINGS.baseUrl),
      apiKey: typeof value.apiKey === "string" ? value.apiKey : "",
      model: nonEmptyString(value.model, DEFAULT_PROVIDER_SETTINGS.model),
      supportsImages: value.supportsImages === true,
    };
  } catch {
    return { ...DEFAULT_PROVIDER_SETTINGS };
  }
}

export function saveAgentProviderSettings(settings: AgentProviderSettings): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(AI_PROVIDER_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Credentials still apply to this session when persistent storage is unavailable.
  }
}

function nonEmptyString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}
