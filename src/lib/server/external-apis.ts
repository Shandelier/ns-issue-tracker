import { randomUUID } from "crypto";
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { ProxyAgent, setGlobalDispatcher } from "undici";

type BooleanLike = string | number | boolean | undefined | null;

const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
}

const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.EXTERNAL_API_TIMEOUT_MS ?? "", 10);
const FALLBACK_TIMEOUT_MS = Number.isFinite(DEFAULT_TIMEOUT_MS) && DEFAULT_TIMEOUT_MS > 0
  ? DEFAULT_TIMEOUT_MS
  : 15_000;

const DEBUG_EXTERNAL_API = normalizeBoolean(process.env.EXTERNAL_API_DEBUG);

const DEFAULT_GITHUB_USER_AGENT =
  process.env.GITHUB_USER_AGENT?.trim() || "issue-estimator";

const OPENROUTER_DEFAULT_HEADERS = buildOpenRouterHeaders();

type HeadersLike = HeadersInit | undefined;

export type GitHubRequestOptions = {
  token?: string;
  timeoutMs?: number;
  requestId?: string;
  init?: RequestInit;
};

export type GitHubRequestResult<T> = {
  data: T;
  requestId: string;
  durationMs: number;
};

export type OpenRouterChatOptions = {
  apiKey?: string;
  model?: string;
  temperature?: number;
  messages: ChatCompletionMessageParam[];
  timeoutMs?: number;
  requestId?: string;
};

export type OpenRouterChatResult = {
  content: string;
  raw: Awaited<ReturnType<OpenAI["chat"]["completions"]["create"]>>;
  requestId: string;
  durationMs: number;
};

const openRouterClientCache = new Map<string, OpenAI>();

export async function githubRequestJson<T>(
  input: string | URL,
  options: GitHubRequestOptions = {}
): Promise<GitHubRequestResult<T>> {
  const requestId = options.requestId ?? randomUUID();
  const timeoutMs = resolveTimeout(options.timeoutMs);
  const startedAt = Date.now();
  const method = options.init?.method ?? "GET";
  const url = new URL(input instanceof URL ? input.toString() : input, "https://api.github.com");

  const controller = new AbortController();
  const timeoutHandle =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null;

  const headers = mergeHeaders(
    {
      Accept: "application/vnd.github+json",
      "User-Agent": DEFAULT_GITHUB_USER_AGENT,
    },
    options.init?.headers
  );

  const token = options.token?.trim() || process.env.GITHUB_TOKEN?.trim();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  debugLog("github", requestId, `→ ${method} ${url.pathname}`, { search: url.search ?? "" });

  try {
    const response = await fetch(url, {
      ...options.init,
      method,
      headers,
      signal: controller.signal,
    });

    const durationMs = Date.now() - startedAt;
    debugLog("github", requestId, `← ${response.status} ${method} ${url.pathname} (${durationMs}ms)`);

    if (!response.ok) {
      const body = await safeReadText(response);
      const message = `[GitHub] ${response.status} ${response.statusText}: ${body}`;
      throw new Error(message.trim());
    }

    const data = (await response.json()) as T;
    return {
      data,
      requestId,
      durationMs,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`[GitHub] Request timed out after ${timeoutMs}ms (${url.pathname}) (${requestId})`);
    }
    throw enrichError(error, "GitHub", { requestId, path: url.pathname });
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

export async function openRouterChat(
  options: OpenRouterChatOptions
): Promise<OpenRouterChatResult> {
  const requestId = options.requestId ?? randomUUID();
  const timeoutMs = resolveTimeout(options.timeoutMs);
  const apiKey = options.apiKey?.trim() || process.env.OPENROUTER_API_KEY?.trim() || process.env.OPENROUTER_KEY?.trim() || process.env.OPENAI_API_KEY?.trim() || process.env.OPENAI_KEY?.trim();

  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not configured");
  }

  const model = options.model?.trim() || process.env.OPENROUTER_MODEL?.trim() || "x-ai/grok-code-fast-1";
  const temperature = typeof options.temperature === "number" ? options.temperature : 0.2;
  const client = ensureOpenRouterClient(apiKey);

  debugLog("openrouter", requestId, `→ model=${model}`);

  const startedAt = Date.now();

  try {
    const rawPromise = client.chat.completions.create({
      model,
      temperature,
      messages: options.messages,
    });

    const raw = await withTimeout(rawPromise, timeoutMs);
    const durationMs = Date.now() - startedAt;

    const content = raw.choices?.[0]?.message?.content?.trim() || "";
    if (!content) {
      throw new Error("[OpenRouter] Response did not include any content");
    }

    debugLog("openrouter", requestId, `← completed (${durationMs}ms)`);

    return {
      content,
      raw,
      requestId,
      durationMs,
    };
  } catch (error) {
    throw enrichError(error, "OpenRouter", { requestId, model });
  }
}

function ensureOpenRouterClient(apiKey: string): OpenAI {
  let client = openRouterClientCache.get(apiKey);
  if (client) {
    return client;
  }

  client = new OpenAI({
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
    defaultHeaders: OPENROUTER_DEFAULT_HEADERS,
  });

  openRouterClientCache.set(apiKey, client);
  return client;
}

function mergeHeaders(defaults: Record<string, string>, override: HeadersLike) {
  const result = new Headers(defaults);
  if (!override) {
    return result;
  }

  const extra = new Headers(override);
  extra.forEach((value, key) => {
    result.set(key, value);
  });
  return result;
}

function normalizeBoolean(value: BooleanLike): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return false;
  return ["1", "true", "yes", "on"].includes(normalized);
}

function resolveTimeout(candidate?: number): number {
  if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
    return candidate;
  }
  return FALLBACK_TIMEOUT_MS;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }

  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`[OpenRouter] Request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

async function safeReadText(response: Response) {
  try {
    const text = await response.text();
    return truncate(text, 800);
  } catch {
    return "<unable to read response body>";
  }
}

function truncate(value: string, limit: number) {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit)}...`;
}

function enrichError(error: unknown, service: "GitHub" | "OpenRouter", meta: Record<string, unknown>) {
  if (error instanceof Error) {
    error.message = `${error.message} (${service} request ${meta.requestId ?? "unknown"})`;
    return error;
  }
  return new Error(`[${service}] Unexpected error (${meta.requestId ?? "unknown"})`);
}

function debugLog(service: "github" | "openrouter", requestId: string, message: string, extra?: Record<string, unknown>) {
  if (!DEBUG_EXTERNAL_API) {
    return;
  }
  const payload = extra && Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : "";
  console.log(`[external:${service}] ${requestId} ${message}${payload}`);
}

function buildOpenRouterHeaders() {
  const referer = process.env.OPENROUTER_SITE_URL?.trim();
  const title = process.env.OPENROUTER_APP_TITLE?.trim() || process.env.OPENROUTER_APP_NAME?.trim();
  const headers: Record<string, string> = {};

  if (referer) {
    headers["HTTP-Referer"] = referer;
  }
  if (title) {
    headers["X-Title"] = title;
  }

  return headers;
}
