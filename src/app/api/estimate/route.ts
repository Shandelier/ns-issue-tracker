import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createHash } from "crypto";
import { extname, join } from "path";
import { mkdir, writeFile } from "fs/promises";
import { AUTH_COOKIE_NAME, isAuthorizedCookie, readConfiguredPasswordHash } from "@/lib/auth";
import { githubRequestJson, openRouterChat } from "@/lib/server/external-apis";
import { ProgressOverrides, ProgressStage, setProgressStage } from "@/lib/server/progress";

export const runtime = "nodejs";

const DEFAULT_ISSUE_BATCH_SIZE = 5;
const OPENROUTER_CHUNK_SIZES = [5, 3, 1] as const;
const OPENROUTER_CHUNK_TIMEOUT_MS = 35_000;
const FILE_CONTEXT_CACHE_TTL_MS = 5 * 60 * 1000;

type GitHubIssue = {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  labels: Array<{ name?: string } | string>;
  comments: number;
  comments_url: string;
};

type GitHubComment = {
  body: string | null;
};

type GitHubRepo = {
  default_branch?: string;
};

type GitHubContentFile = {
  type: "file" | "dir" | string;
  path: string;
  name: string;
  size?: number;
  sha?: string;
  content?: string;
  encoding?: string;
};

type RepoTreeNode = {
  path: string;
  name: string;
  type: "file" | "dir";
  size?: number;
  sha?: string;
  children?: RepoTreeNode[];
};

type FileContextCacheEntry = {
  key: string;
  repo: string;
  branch: string;
  selectionKey: string;
  contexts: string[];
  files: FileContext[];
  expiresAt: number;
};

const fileContextCache = new Map<string, FileContextCacheEntry>();

function createSelectionKey(paths: string[]) {
  if (!paths.length) {
    return "";
  }
  const normalized = [...paths].map((entry) => entry.trim()).filter(Boolean).sort();
  return normalized.join("\n");
}

function createFileContextCacheKey(owner: string, repo: string, branch: string, paths: string[]) {
  const selectionKey = createSelectionKey(paths);
  const hash = createHash("sha256").update(selectionKey).digest("hex").slice(0, 12);
  return {
    key: `${owner}/${repo}@${branch}:${hash}`,
    selectionKey,
  };
}

function purgeExpiredFileContexts(now = Date.now()) {
  fileContextCache.forEach((entry, key) => {
    if (entry.expiresAt <= now) {
      fileContextCache.delete(key);
    }
  });
}

function getCachedFileContexts(cacheKey: string, selectionKey: string) {
  purgeExpiredFileContexts();
  const entry = fileContextCache.get(cacheKey);
  if (!entry) {
    console.info(`[context-cache] miss ${cacheKey} (no entry)`);
    return null;
  }
  if (entry.selectionKey !== selectionKey) {
    console.info(`[context-cache] miss ${cacheKey} (selection mismatch)`);
    return null;
  }
  entry.expiresAt = Date.now() + FILE_CONTEXT_CACHE_TTL_MS;
  console.info(`[context-cache] hit ${cacheKey}`);
  return {
    contexts: entry.contexts,
    files: entry.files,
  };
}

function setCachedFileContexts(
  cacheKey: string,
  selectionKey: string,
  repo: string,
  branch: string,
  payload: { contexts: string[]; files: FileContext[] }
) {
  const expiresAt = Date.now() + FILE_CONTEXT_CACHE_TTL_MS;
  fileContextCache.set(cacheKey, {
    key: cacheKey,
    repo,
    branch,
    selectionKey,
    contexts: payload.contexts,
    files: payload.files,
    expiresAt,
  });
  console.info(`[context-cache] store ${cacheKey} (expires in ${FILE_CONTEXT_CACHE_TTL_MS}ms)`);
  return payload;
}

function parseGitHubUrl(repoUrl: string) {
  try {
    const url = new URL(repoUrl);
    if (url.hostname !== "github.com") return null;
    const [owner, repo] = url.pathname.replace(/^\//, "").split("/");
    if (!owner || !repo) return null;
    return { owner, repo: repo.replace(/\.git$/, "") };
  } catch {
    return null;
  }
}

async function fetchIssues(
  owner: string,
  repo: string,
  githubToken?: string,
  options?: {
    limit?: number;
    page?: number;
  }
): Promise<{ issues: GitHubIssue[]; hasMore: boolean }> {
  const rawLimit = options?.limit;
  const limit =
    rawLimit && Number.isFinite(rawLimit) && rawLimit > 0 ? Math.max(1, Math.min(100, Math.floor(rawLimit))) : undefined;
  const rawPage = options?.page;
  const page =
    rawPage && Number.isFinite(rawPage) && rawPage > 0 ? Math.max(1, Math.min(1000, Math.floor(rawPage))) : undefined;

  if (page) {
    const effectiveLimit = limit ?? DEFAULT_ISSUE_BATCH_SIZE;
    const requestPageSize = Math.max(1, Math.min(effectiveLimit, 100));
    const { data: batch } = await githubRequestJson<GitHubIssue[]>(
      `https://api.github.com/repos/${owner}/${repo}/issues?state=open&per_page=${requestPageSize}&page=${page}`,
      { token: githubToken }
    );

    if (batch.length === 0) {
      return { issues: [], hasMore: false };
    }

    const filtered = batch.filter((issue: any) => !issue.pull_request);
    const trimmed = filtered.slice(0, effectiveLimit);
    const hasMore = batch.length === requestPageSize;
    return { issues: trimmed, hasMore };
  }

  const issues: GitHubIssue[] = [];
  let pageIndex = 1;

  while (true) {
    const remaining = limit ? Math.max(limit - issues.length, 0) : undefined;
    if (remaining === 0) {
      return { issues: issues.slice(0, limit), hasMore: true };
    }

    const perPage = remaining ? Math.min(remaining + 1, 100) : 100;
    const { data: batch } = await githubRequestJson<GitHubIssue[]>(
      `https://api.github.com/repos/${owner}/${repo}/issues?state=open&per_page=${perPage}&page=${pageIndex}`,
      { token: githubToken }
    );

    if (batch.length === 0) {
      break;
    }

    const filtered = batch.filter((issue: any) => !issue.pull_request);
    const trimmed = remaining ? filtered.slice(0, Math.max(remaining, 0)) : filtered;
    issues.push(...trimmed);

    if (limit && issues.length >= limit) {
      return { issues: issues.slice(0, limit), hasMore: batch.length === perPage };
    }

    if (batch.length < perPage) {
      break;
    }
    pageIndex += 1;
  }

  return { issues, hasMore: false };
}

const ISSUE_COMMENT_FETCH_LIMIT = 5;

async function fetchIssueComments(
  issue: GitHubIssue,
  githubToken?: string
): Promise<string[]> {
  if (!issue.comments) {
    return [];
  }

  const { data: comments } = await githubRequestJson<GitHubComment[]>(
    `${issue.comments_url}?per_page=${ISSUE_COMMENT_FETCH_LIMIT}`,
    { token: githubToken }
  );

  return comments
    .map((comment) => comment.body?.trim())
    .filter((body): body is string => Boolean(body))
    .slice(0, ISSUE_COMMENT_FETCH_LIMIT);
}

async function fetchRepoInfo(owner: string, repo: string, githubToken?: string) {
  const { data } = await githubRequestJson<GitHubRepo>(
    `https://api.github.com/repos/${owner}/${repo}`,
    { token: githubToken }
  );
  return data;
}

async function fetchDirectoryEntries(
  owner: string,
  repo: string,
  path: string,
  ref: string,
  githubToken?: string
) {
  const encodedPath = path
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  const suffix = encodedPath ? `/${encodedPath}` : "";
  const refParam = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  const { data } = await githubRequestJson<GitHubContentFile[] | GitHubContentFile>(
    `https://api.github.com/repos/${owner}/${repo}/contents${suffix}${refParam}`,
    { token: githubToken }
  );
  return data;
}

async function fetchRepoTree(
  owner: string,
  repo: string,
  githubToken?: string,
  maxDepth = 3,
  branch?: string
): Promise<RepoTreeNode[]> {
  const repoInfo = branch ? { default_branch: branch } : await fetchRepoInfo(owner, repo, githubToken);
  const ref = repoInfo.default_branch ?? "main";

  async function walk(path: string, depth: number): Promise<RepoTreeNode[]> {
    if (depth > maxDepth) {
      return [];
    }

    const response = await fetchDirectoryEntries(owner, repo, path, ref, githubToken);
    if (!Array.isArray(response)) {
      return [];
    }

    const nodes: RepoTreeNode[] = [];
    for (const entry of response) {
      if (!entry || !entry.path || !entry.name) continue;
      if (entry.type !== "file" && entry.type !== "dir") continue;

      const node: RepoTreeNode = {
        path: entry.path,
        name: entry.name,
        type: entry.type,
        size: entry.size,
        sha: entry.sha,
      };

      if (entry.type === "dir" && depth < maxDepth) {
        node.children = await walk(entry.path, depth + 1);
      }

      nodes.push(node);
    }

    return nodes.sort((a, b) => {
      if (a.type === b.type) return a.name.localeCompare(b.name);
      return a.type === "dir" ? -1 : 1;
    });
  }

  return await walk("", 1);
}

async function gatherFilePaths(
  owner: string,
  repo: string,
  selections: string[],
  githubToken?: string,
  branch?: string
) {
  if (!selections.length) return [];

  const repoInfo = branch ? { default_branch: branch } : await fetchRepoInfo(owner, repo, githubToken);
  const ref = repoInfo.default_branch ?? "main";

  const collected = new Set<string>();
  const stack = selections.map((selection) => selection.trim()).filter(Boolean);

  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;

    const response = await fetchDirectoryEntries(owner, repo, current, ref, githubToken);

    if (Array.isArray(response)) {
      for (const entry of response) {
        if (!entry || !entry.path) continue;
        if (entry.type === "file") {
          collected.add(entry.path);
        } else if (entry.type === "dir") {
          stack.push(entry.path);
        }
      }
    } else if (response.type === "file") {
      collected.add(response.path);
    }
  }

  return Array.from(collected).sort();
}

function inferLanguage(filePath: string) {
  const extension = extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".ts": "ts",
    ".tsx": "tsx",
    ".js": "js",
    ".jsx": "jsx",
    ".mjs": "js",
    ".cjs": "js",
    ".json": "json",
    ".yml": "yaml",
    ".yaml": "yaml",
    ".md": "markdown",
    ".mdx": "markdown",
    ".css": "css",
    ".scss": "scss",
    ".sass": "sass",
    ".less": "less",
    ".html": "html",
    ".htm": "html",
    ".py": "python",
    ".rb": "ruby",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".cs": "csharp",
    ".php": "php",
    ".sh": "bash",
    ".bash": "bash",
    ".zsh": "bash",
    ".env": "bash",
    ".txt": "text",
    ".toml": "toml",
    ".ini": "ini",
    ".cfg": "ini",
    ".conf": "ini",
  };
  return map[extension] ?? "text";
}

function isProbablyBinary(content: string) {
  return /\u0000/.test(content);
}

function truncateContent(content: string, limit = 60000) {
  if (content.length <= limit) {
    return { text: content, truncated: false };
  }
  return {
    text: `${content.slice(0, limit)}\n...\n[truncated ${content.length - limit} chars]`,
    truncated: true,
  };
}

function applyFileContextBudget(files: FileContext[], budget: number) {
  if (!files.length) {
    return files;
  }

  const safeBudget = Number.isFinite(budget) && budget > 0 ? Math.floor(budget) : 0;
  if (safeBudget <= 0) {
    return files.map((file) => ({
      ...file,
      content: "",
      truncated: file.content.length > 0 ? true : file.truncated,
    }));
  }

  const lengths = files.map((file) => file.content.length);
  const totalLength = lengths.reduce((acc, len) => acc + len, 0);
  if (totalLength <= safeBudget) {
    return files;
  }

  const maxLength = Math.max(...lengths);
  let low = 0;
  let high = maxLength;
  let bestLimit = 0;

  const cappedTotal = (limit: number) =>
    lengths.reduce((sum, len) => sum + Math.min(len, limit), 0);

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (cappedTotal(mid) <= safeBudget) {
      bestLimit = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  if (bestLimit <= 0) {
    return files.map((file) => ({
      ...file,
      content: "",
      truncated: file.content.length > 0 ? true : file.truncated,
    }));
  }

  return files.map((file) => {
    if (file.content.length <= bestLimit) {
      return file;
    }
    const { text } = truncateContent(file.content, bestLimit);
    return {
      ...file,
      content: text,
      truncated: true,
    };
  });
}

type FileContext = {
  path: string;
  language: string;
  lines: number;
  hash: string;
  content: string;
  truncated: boolean;
};

async function fetchFileContext(
  owner: string,
  repo: string,
  path: string,
  ref: string,
  githubToken?: string
): Promise<FileContext | null> {
  const encodedPath = path
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  const refParam = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  const { data: response } = await githubRequestJson<GitHubContentFile>(
    `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}${refParam}`,
    { token: githubToken }
  );

  if (response.type !== "file" || !response.content) {
    return null;
  }

  const buffer = Buffer.from(response.content, "base64");
  const fullContent = buffer.toString("utf8");
  if (isProbablyBinary(fullContent)) {
    return null;
  }

  const lines = fullContent.split(/\r?\n/).length;
  const hash = createHash("sha256").update(fullContent).digest("hex").slice(0, 8);
  const { text, truncated } = truncateContent(fullContent);

  return {
    path,
    language: inferLanguage(path),
    lines,
    hash,
    content: text,
    truncated,
  };
}

function formatFileContext(file: FileContext) {
  const qualifiers = [`lang=${file.language}`, `lines=${file.lines}`, `sha256=${file.hash}`];
  if (file.truncated) {
    qualifiers.push("truncated=true");
  }
  const header = `=== BEGIN FILE: ${file.path} (${qualifiers.join(", ")}) ===`;
  const footer = `=== END FILE: ${file.path} ===`;
  return `${header}
\`\`\`${file.language}
${file.content}
\`\`\`
${footer}`;
}

const MAX_SELECTED_FILES = 25;
const FILE_CONTEXT_TOTAL_BUDGET = 30_000;

type SuggestedPathCandidate = {
  path: string;
  score: number;
  depth: number;
};

function suggestDefaultPaths(tree: RepoTreeNode[], limit = 12) {
  const candidates: SuggestedPathCandidate[] = [];
  const fallback: SuggestedPathCandidate[] = [];

  const exactScores = new Map<string, number>([
    ["readme.md", 120],
    ["readme", 115],
    ["readme.txt", 110],
    ["contributing.md", 90],
    ["package.json", 95],
    ["requirements.txt", 95],
    ["pyproject.toml", 90],
    ["setup.py", 80],
    ["composer.json", 85],
    ["gemfile", 80],
    ["cargo.toml", 90],
    ["go.mod", 90],
    ["go.sum", 60],
    ["build.gradle", 85],
    ["build.gradle.kts", 85],
    ["pom.xml", 85],
    ["docker-compose.yml", 70],
    ["docker-compose.yaml", 70],
    ["dockerfile", 65],
    ["makefile", 60],
    ["tsconfig.json", 55],
    ["next.config.mjs", 55],
    ["eslint.config.mjs", 50],
  ]);

  const pathMatchers: Array<{ score: number; test: (path: string) => boolean }> = [
    { score: 80, test: (path) => /(^|\/)docs?\/readme/i.test(path) },
    { score: 75, test: (path) => /(^|\/)src\/index\.(ts|tsx|js|jsx|py|rb|php|go)$/.test(path) },
    { score: 72, test: (path) => /(^|\/)src\/main\.(ts|tsx|js|jsx|py|rb|java|go)$/.test(path) },
    { score: 70, test: (path) => /(^|\/)src\/app\.(ts|tsx|js|jsx)$/.test(path) },
    { score: 68, test: (path) => /(^|\/)src\/server\.(ts|tsx|js|jsx)$/.test(path) },
    { score: 65, test: (path) => /(^|\/)src\/app\/page\.(ts|tsx|js|jsx)$/.test(path) },
    { score: 62, test: (path) => /(^|\/)src\/main\.(rs|rb|cs)$/.test(path) },
  ];

  function traverse(nodes: RepoTreeNode[], depth: number) {
    for (const node of nodes) {
      if (!node) continue;
      if (node.type === "file") {
        const lowerName = node.name.toLowerCase();
        const lowerPath = node.path.toLowerCase();
        let score = 0;

        if (exactScores.has(lowerName)) {
          score = Math.max(score, exactScores.get(lowerName) ?? 0);
        }
        if (lowerName.startsWith("readme")) {
          score = Math.max(score, 105);
        }
        for (const matcher of pathMatchers) {
          if (matcher.test(lowerPath)) {
            score = Math.max(score, matcher.score);
          }
        }
        if (lowerPath.endsWith(".md") && score === 0) {
          score = 40;
        }

        if (score > 0) {
          candidates.push({ path: node.path, score, depth });
        } else if (depth <= 2) {
          fallback.push({ path: node.path, score: 10 - depth, depth });
        }
      }

      if (node.type === "dir" && node.children?.length) {
        traverse(node.children, depth + 1);
      }
    }
  }

  traverse(tree, 0);

  const ranked = candidates
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.depth !== b.depth) return a.depth - b.depth;
      return a.path.localeCompare(b.path);
    })
    .map((candidate) => candidate.path);

  const unique = new Set<string>();
  const suggestions: string[] = [];
  for (const path of ranked) {
    if (!unique.has(path)) {
      unique.add(path);
      suggestions.push(path);
      if (suggestions.length >= limit) {
        return suggestions;
      }
    }
  }

  const fallbackSorted = fallback
    .sort((a, b) => {
      if (a.depth !== b.depth) return a.depth - b.depth;
      if (a.path.length !== b.path.length) return a.path.length - b.path.length;
      return a.path.localeCompare(b.path);
    })
    .map((candidate) => candidate.path);

  for (const path of fallbackSorted) {
    if (!unique.has(path)) {
      unique.add(path);
      suggestions.push(path);
      if (suggestions.length >= limit) {
        break;
      }
    }
  }

  return suggestions;
}

async function buildFileContexts(
  owner: string,
  repo: string,
  selections: string[],
  githubToken?: string,
  branch?: string
) {
  if (!selections.length) return { contexts: [], files: [] as FileContext[] };

  const repoInfo = branch ? { default_branch: branch } : await fetchRepoInfo(owner, repo, githubToken);
  const ref = repoInfo.default_branch ?? "main";
  const filePaths = await gatherFilePaths(owner, repo, selections, githubToken, ref);

  if (!filePaths.length) {
    return { contexts: [], files: [] as FileContext[] };
  }

  const limitedPaths = filePaths.slice(0, MAX_SELECTED_FILES);
  const files = (
    await Promise.all(
      limitedPaths.map((filePath) =>
        fetchFileContext(owner, repo, filePath, ref, githubToken).catch(() => null)
      )
    )
  ).filter((file): file is FileContext => Boolean(file));

  const budgetedFiles = applyFileContextBudget(files, FILE_CONTEXT_TOTAL_BUDGET);

  return {
    contexts: budgetedFiles.map(formatFileContext),
    files: budgetedFiles,
  };
}

type IssueSummary = {
  number: number;
  title: string;
  body: string;
  labels: string[];
  comments: string[];
  url: string;
};

const ISSUE_BODY_CHAR_LIMIT = 6000;
const ISSUE_COMMENT_CHAR_LIMIT = 1000;

async function buildIssuesPayload(
  issues: GitHubIssue[],
  githubToken?: string
): Promise<IssueSummary[]> {
  const payload = await Promise.all(
    issues.map(async (issue) => {
      const labels = (issue.labels ?? []).map((label) =>
        typeof label === "string" ? label : label.name ?? ""
      );
      const comments = await fetchIssueComments(issue, githubToken);
      const bodyPayload = truncateContent(issue.body ?? "", ISSUE_BODY_CHAR_LIMIT);
      const processedComments = comments.map(
        (comment) => truncateContent(comment, ISSUE_COMMENT_CHAR_LIMIT).text
      );
      return {
        number: issue.number,
        title: issue.title,
        body: bodyPayload.text,
        labels: labels.filter(Boolean),
        comments: processedComments,
        url: issue.html_url,
      };
    })
  );

  return payload;
}

function coerceJsonPayload(rawText: string) {
  const trimmed = rawText.trim();
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fencedMatch ? fencedMatch[1] : trimmed;
  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  const jsonText =
    firstBrace !== -1 && lastBrace !== -1 ? candidate.slice(firstBrace, lastBrace + 1) : candidate;
  return JSON.parse(jsonText);
}

type DebugCaptureOptions = {
  enabledOverride?: boolean;
  baseDirOverride?: string;
};

function isDebugCaptureEnabled(override?: boolean) {
  if (typeof override === "boolean") {
    return override;
  }

  const flag =
    process.env.OPENROUTER_DEBUG_MODE ??
    process.env.OPENROUTER_DEBUG ??
    process.env.OPENROUTER_SAVE_PROMPTS;
  if (!flag) {
    return false;
  }
  const normalized = flag.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return !["0", "false", "off", "no"].includes(normalized);
}

function resolveDebugDirectory(explicitDir?: string) {
  if (explicitDir && explicitDir.trim().length) {
    return explicitDir;
  }

  return (
    process.env.OPENROUTER_DEBUG_DIR ||
    process.env.OPENROUTER_DEBUG_PATH ||
    join(process.cwd(), ".openrouter-debug")
  );
}

async function captureDebugPayload(
  issueSummaries: IssueSummary[],
  fileContexts: string[],
  userPrompt: string,
  options?: DebugCaptureOptions
): Promise<string | null> {
  if (!isDebugCaptureEnabled(options?.enabledOverride)) {
    return null;
  }

  const now = new Date();
  const baseDir = resolveDebugDirectory(options?.baseDirOverride);
  const sessionId = `${now.toISOString().replace(/[:.]/g, "-")}-${Math.random()
    .toString(16)
    .slice(2, 8)}`;
  const sessionDir = join(baseDir, sessionId);

  try {
    await mkdir(sessionDir, { recursive: true });

    const metadata = {
      createdAt: now.toISOString(),
      issueCount: issueSummaries.length,
      fileContextChunkCount: fileContexts.length,
    };

    const writes: Promise<void>[] = [
      writeFile(join(sessionDir, "metadata.json"), JSON.stringify(metadata, null, 2), "utf8"),
      writeFile(join(sessionDir, "issues.compact.json"), JSON.stringify(issueSummaries), "utf8"),
      writeFile(join(sessionDir, "issues.pretty.json"), JSON.stringify(issueSummaries, null, 2), "utf8"),
      writeFile(join(sessionDir, "prompt.txt"), userPrompt, "utf8"),
    ];

    if (fileContexts.length) {
      writes.push(
        writeFile(join(sessionDir, "file-contexts.txt"), fileContexts.join("\n\n"), "utf8")
      );
    }

    for (const issue of issueSummaries) {
      writes.push(
        writeFile(
          join(sessionDir, `issue-${issue.number}.json`),
          JSON.stringify(issue, null, 2),
          "utf8"
        )
      );
    }

    await Promise.all(writes);
    return sessionDir;
  } catch (error) {
    console.warn("Failed to capture OpenRouter debug payload:", error);
    return null;
  }
}

type RequestEstimatesOptions = {
  debugCapture?: boolean;
  model?: string;
  progress?: (stage: ProgressStage, overrides?: ProgressOverrides) => void;
  apiKey?: string;
};

type ChunkProgressMeta = {
  chunkIndex: number;
  processedCount: number;
  totalCount: number;
};

type ChunkEstimatesResult = {
  estimates: Array<{
    issue_number: number;
    complexity: string;
    estimated_cost: string;
  }>;
  debugPath: string | null;
};

async function requestEstimatesForChunk(
  issueSummaries: IssueSummary[],
  fileContexts: string[],
  systemPrompt: string,
  filesSection: string,
  model: string,
  options: RequestEstimatesOptions | undefined,
  meta: ChunkProgressMeta
): Promise<ChunkEstimatesResult> {
  if (!issueSummaries.length) {
    return { estimates: [], debugPath: null };
  }

  const issuesSection = `Here are the issues from a repository. Analyze them collectively and respond with JSON only.
${JSON.stringify(issueSummaries)}`;

  const userPrompt = `${issuesSection}${filesSection}
`;

  const debugPath = await captureDebugPayload(issueSummaries, fileContexts, userPrompt, {
    enabledOverride: options?.debugCapture,
  });

  const overrides: ProgressOverrides = {
    message: `Calling OpenRouter (chunk ${meta.chunkIndex + 1}, size ${issueSummaries.length}).`,
  };

  if (meta.totalCount > 0) {
    const completionRatio = meta.processedCount / meta.totalCount;
    if (Number.isFinite(completionRatio)) {
      overrides.value = Math.min(0.8 + completionRatio * 0.1, 0.91);
    }
  }
  overrides.processedCount = meta.processedCount;
  overrides.totalCount = meta.totalCount;

  options?.progress?.("calling_openrouter", overrides);

  const startedAt = Date.now();
  let content: string;
  try {
    ({ content } = await openRouterChat({
      model,
      apiKey: options?.apiKey,
      temperature: 0.2,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      timeoutMs: OPENROUTER_CHUNK_TIMEOUT_MS,
    }));
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    const rawMessage = error instanceof Error ? error.message : String(error ?? "Unknown error");
    console.warn(
      `[estimate] OpenRouter chunk ${meta.chunkIndex + 1} (size ${issueSummaries.length}) failed after ${elapsedMs}ms: ${rawMessage}`
    );
    throw error;
  }

  const elapsedMs = Date.now() - startedAt;
  console.info(
    `[estimate] OpenRouter chunk ${meta.chunkIndex + 1} (size ${issueSummaries.length}) completed in ${elapsedMs}ms`
  );

  let parsed: {
    estimates?: Array<{
      issue_number: number;
      complexity: string;
      estimated_cost: string;
    }>;
  };
  try {
    parsed = coerceJsonPayload(content) as {
      estimates?: Array<{
        issue_number: number;
        complexity: string;
        estimated_cost: string;
      }>;
    };
  } catch {
    throw new Error(`Unable to parse OpenRouter response for chunk ${meta.chunkIndex + 1}`);
  }

  return {
    estimates: parsed.estimates ?? [],
    debugPath,
  };
}

async function requestEstimates(
  issueSummaries: IssueSummary[],
  fileContexts: string[],
  options?: RequestEstimatesOptions
) {
  if (!issueSummaries.length) {
    return { estimates: [], debugPath: null };
  }

  const systemPrompt = `You are a budgeting assistant. Estimate the complexity and US Dollar cost of solving the GitHub issues.
Return JSON with an array "estimates" where each entry contains issue_number, complexity (one of Low, Medium, High),
and estimated_cost (a string like "$250" in range of $100-$10000). Use the details about the issue and repo files selected by the user for precise estimation. Take into account complexity of the project and the issue. In estimation assume the task will be solved by a single experienced developer. keep explanations brief.`;

  const filesSection = fileContexts.length
    ? `\n\nHere is additional repository context:\n${fileContexts.join("\n\n")}`
    : "";

  const requestedModel = options?.model?.trim();
  const envDefault = process.env.OPENROUTER_MODEL?.trim();
  const model =
    requestedModel && requestedModel.length > 0
      ? requestedModel
      : envDefault && envDefault.length > 0
        ? envDefault
        : "x-ai/grok-code-fast-1";

  const issueNumbers = new Set(issueSummaries.map((issue) => issue.number));
  const aggregate = new Map<number, { issue_number: number; complexity: string; estimated_cost: string }>();
  const debugPaths: string[] = [];

  const totalCount = issueSummaries.length;
  let processedCount = 0;
  let chunkIndex = 0;
  let preferredSizeIndex = 0;

  while (processedCount < totalCount) {
    let attemptIndex = preferredSizeIndex;
    let lastError: unknown;
    let handled = false;

    while (attemptIndex < OPENROUTER_CHUNK_SIZES.length) {
      const attemptSize = OPENROUTER_CHUNK_SIZES[attemptIndex];
      const chunk = issueSummaries.slice(
        processedCount,
        Math.min(processedCount + attemptSize, totalCount)
      );

      if (!chunk.length) {
        handled = true;
        processedCount = totalCount;
        break;
      }

      try {
        const { estimates, debugPath } = await requestEstimatesForChunk(
          chunk,
          fileContexts,
          systemPrompt,
          filesSection,
          model,
          options,
          {
            chunkIndex,
            processedCount,
            totalCount,
          }
        );

        const chunkEstimates = new Map<
          number,
          { issue_number: number; complexity: string; estimated_cost: string }
        >();

        for (const estimate of estimates) {
          if (!estimate) continue;
          const candidateNumber = Number((estimate as { issue_number: unknown }).issue_number);
          if (!Number.isFinite(candidateNumber)) continue;
          const normalizedNumber = Math.trunc(candidateNumber);
          if (!issueNumbers.has(normalizedNumber)) continue;

          chunkEstimates.set(normalizedNumber, {
            issue_number: normalizedNumber,
            complexity: String(estimate.complexity),
            estimated_cost: String(estimate.estimated_cost),
          });
        }

        const missingInChunk = chunk
          .map((issue) => issue.number)
          .filter((issueNumber) => !chunkEstimates.has(issueNumber));

        if (missingInChunk.length) {
          throw new Error(
            `OpenRouter response missing estimate${missingInChunk.length === 1 ? "" : "s"} for chunk ${
              chunkIndex + 1
            }: ${missingInChunk.join(", ")}`
          );
        }

        if (debugPath && debugPaths.length === 0) {
          debugPaths.push(debugPath);
        }

        chunkEstimates.forEach((estimate) => {
          aggregate.set(estimate.issue_number, estimate);
        });

        const updatedProcessedCount = processedCount + chunk.length;
        options?.progress?.("calling_openrouter", {
          message: `Received estimates for ${Math.min(updatedProcessedCount, totalCount)} of ${totalCount} issue${
            totalCount === 1 ? "" : "s"
          }.`,
          processedCount: updatedProcessedCount,
          totalCount,
          value: totalCount
            ? Math.min(0.8 + (updatedProcessedCount / totalCount) * 0.1, 0.91)
            : undefined,
        });

        processedCount = updatedProcessedCount;
        chunkIndex += 1;
        preferredSizeIndex = attemptIndex;
        handled = true;
        break;
      } catch (error) {
        lastError = error;
        attemptIndex += 1;

        if (attemptIndex < OPENROUTER_CHUNK_SIZES.length) {
          const retrySize = OPENROUTER_CHUNK_SIZES[attemptIndex];
          const rawMessage =
            error instanceof Error ? error.message : String(error ?? "Unknown error");
          const message =
            rawMessage.length > 180 ? `${rawMessage.slice(0, 177)}...` : rawMessage;
          options?.progress?.("calling_openrouter", {
            message: `Retrying OpenRouter request with chunk size ${retrySize} (chunk ${chunkIndex + 1}) after error: ${message}`,
          });
        }
      }
    }

    if (!handled) {
      if (lastError instanceof Error) {
        throw lastError;
      }
      throw new Error(
        typeof lastError === "string" ? lastError : "OpenRouter request failed"
      );
    }
  }

  options?.progress?.("parsing_response", {
    message: `Parsing OpenRouter responses for ${issueSummaries.length} issue${issueSummaries.length === 1 ? "" : "s"}.`,
    processedCount: issueSummaries.length,
    totalCount: issueSummaries.length,
  });

  if (aggregate.size !== issueNumbers.size) {
    const missing = issueSummaries
      .filter((issue) => !aggregate.has(issue.number))
      .map((issue) => issue.number);
    throw new Error(
      missing.length
        ? `Missing estimates for issue${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`
        : "Unable to match estimates to issues"
    );
  }

  const orderedEstimates = issueSummaries.map((issue) => {
    const entry = aggregate.get(issue.number);
    if (!entry) {
      throw new Error(`Missing estimate for issue #${issue.number}`);
    }
    return entry;
  });

  return {
    estimates: orderedEstimates,
    debugPath: debugPaths[0] ?? null,
  };
}

export async function POST(request: Request) {
  let updateProgress: ((stage: ProgressStage, overrides?: ProgressOverrides) => void) | undefined;

  try {
    let expectedHash: string;
    try {
      expectedHash = readConfiguredPasswordHash();
    } catch {
      return NextResponse.json({ error: "Authentication is not configured" }, { status: 500 });
    }

    const cookieValue = cookies().get(AUTH_COOKIE_NAME)?.value;
    if (!isAuthorizedCookie(cookieValue, expectedHash)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const repoUrl: string | undefined = body?.repoUrl;
    const githubToken: string | undefined = body?.githubToken;
    const rawIssueLimit = body?.issueLimit;
    const issueLimit =
      typeof rawIssueLimit === "number" && Number.isFinite(rawIssueLimit)
        ? Math.max(1, Math.min(100, Math.floor(rawIssueLimit)))
        : undefined;
    const rawIssuePage = body?.issuePage;
    const issuePage =
      typeof rawIssuePage === "number" && Number.isFinite(rawIssuePage)
        ? Math.max(1, Math.min(1000, Math.floor(rawIssuePage)))
        : undefined;
    const listRepoFiles = Boolean(body?.includeRepoTree);
    const onlyRepoTree = Boolean(body?.onlyRepoTree);
    const rawTreeDepth = body?.treeDepth;
    const treeDepth =
      typeof rawTreeDepth === "number" && Number.isFinite(rawTreeDepth)
        ? Math.max(1, Math.min(5, Math.floor(rawTreeDepth)))
        : 3;
    const selectedPaths: string[] = Array.isArray(body?.selectedPaths)
      ? body.selectedPaths
          .map((entry: unknown) => (typeof entry === "string" ? entry.trim() : ""))
          .filter(Boolean)
      : [];
    const rawModel = typeof body?.model === "string" ? body.model.trim() : "";
    const requestedModel = rawModel.length > 0 ? rawModel : undefined;
    const rawOpenRouterKey =
      typeof body?.openRouterKey === "string" ? body.openRouterKey.trim() : "";
    const openRouterKey = rawOpenRouterKey.length > 0 ? rawOpenRouterKey : undefined;
    const preferredBranch =
      typeof body?.branch === "string" && body.branch.trim().length > 0
        ? body.branch.trim()
        : undefined;
    const needBranchInfo = listRepoFiles || selectedPaths.length > 0 || onlyRepoTree;
    const rawProgressId = typeof body?.progressId === "string" ? body.progressId.trim() : "";
    const progressId =
      rawProgressId && /^[a-zA-Z0-9_-]{6,80}$/.test(rawProgressId) ? rawProgressId : undefined;
    updateProgress = progressId
      ? (stage: ProgressStage, overrides?: ProgressOverrides) =>
          setProgressStage(progressId, stage, overrides)
      : undefined;

    if (updateProgress) {
      updateProgress("pending", { message: "Preparing estimation request." });
    }

    if (!repoUrl) {
      return NextResponse.json({ error: "Repository URL is required" }, { status: 400 });
    }

    const parsed = parseGitHubUrl(repoUrl);
    if (!parsed) {
      return NextResponse.json({ error: "Invalid GitHub repository URL" }, { status: 400 });
    }
    const repoIdentity = `${parsed.owner}/${parsed.repo}`;

    let branchRef = preferredBranch as string | undefined;
    let repoInfo: GitHubRepo | undefined;
    if (!branchRef && needBranchInfo) {
      repoInfo = await fetchRepoInfo(parsed.owner, parsed.repo, githubToken);
      branchRef = repoInfo.default_branch ?? "main";
    }
    const resolvedBranch = branchRef ?? "main";

    if (onlyRepoTree) {
      updateProgress?.("repo_tree", {
        message: `Fetching repository tree (depth ${treeDepth}).`,
      });
      const repoTree = await fetchRepoTree(
        parsed.owner,
        parsed.repo,
        githubToken,
        treeDepth,
        resolvedBranch
      );
      const suggestedPaths = repoTree.length ? suggestDefaultPaths(repoTree) : [];
      updateProgress?.("complete", {
        message: `Loaded ${repoTree.length} top-level entries.`,
      });
      return NextResponse.json({
        repoTree,
        branch: resolvedBranch,
        suggestedPaths,
      });
    }

    const debugCaptureOverride =
      typeof body?.debugCapture === "boolean" ? body.debugCapture : undefined;

    const issueFetchMessage = issuePage
      ? `Requesting page ${issuePage} of up to ${issueLimit ?? DEFAULT_ISSUE_BATCH_SIZE} open issues from GitHub.`
      : issueLimit
      ? `Requesting up to ${issueLimit} open issues from GitHub.`
      : "Requesting all open issues from GitHub.";
    updateProgress?.("fetching_issues", { message: issueFetchMessage });
    const { issues, hasMore } = await fetchIssues(parsed.owner, parsed.repo, githubToken, {
      limit: issueLimit,
      page: issuePage,
    });
    if (issues.length === 0) {
      updateProgress?.("complete", { message: "No open issues detected in the repository." });
      const emptyResponse: Record<string, unknown> = { estimates: [] };
      if (listRepoFiles) {
        const repoTree = await fetchRepoTree(
          parsed.owner,
          parsed.repo,
          githubToken,
          treeDepth,
          resolvedBranch
        );
        emptyResponse.repoTree = repoTree;
        emptyResponse.branch = resolvedBranch;
        emptyResponse.suggestedPaths = repoTree.length ? suggestDefaultPaths(repoTree) : [];
      }
      emptyResponse.hasMore = hasMore;
      return NextResponse.json(emptyResponse);
    }

    updateProgress?.("collecting_context", {
      message: `Fetched ${issues.length} open issue${issues.length === 1 ? "" : "s"}. Collecting context...`,
    });
    const repoTreePromise = listRepoFiles
      ? fetchRepoTree(parsed.owner, parsed.repo, githubToken, treeDepth, resolvedBranch)
      : Promise.resolve<RepoTreeNode[] | undefined>(undefined);

    let fileContextsPromise: Promise<{ contexts: string[]; files: FileContext[] }>;
    if (selectedPaths.length) {
      const { key: cacheKey, selectionKey } = createFileContextCacheKey(
        parsed.owner,
        parsed.repo,
        resolvedBranch,
        selectedPaths
      );
      const cached = getCachedFileContexts(cacheKey, selectionKey);
      if (cached) {
        fileContextsPromise = Promise.resolve(cached);
      } else {
        fileContextsPromise = buildFileContexts(parsed.owner, parsed.repo, selectedPaths, githubToken, resolvedBranch).then(
          (result) => setCachedFileContexts(cacheKey, selectionKey, repoIdentity, resolvedBranch, result)
        );
      }
    } else {
      fileContextsPromise = Promise.resolve({ contexts: [] as string[], files: [] as FileContext[] });
    }

    const summaries = await buildIssuesPayload(issues, githubToken);
    updateProgress?.("preparing_prompt", {
      message: `Prepared ${summaries.length} issue summary${summaries.length === 1 ? "" : "ies"}.`,
    });
    const [{ contexts, files }, repoTree] = await Promise.all([fileContextsPromise, repoTreePromise]);
    if (contexts.length) {
      updateProgress?.("collecting_context", {
        message: `Included ${contexts.length} context chunk${contexts.length === 1 ? "" : "s"} in the prompt.`,
        value: 0.5,
      });
    }
    const { estimates, debugPath } = await requestEstimates(summaries, contexts, {
      debugCapture: debugCaptureOverride,
      model: requestedModel,
      progress: updateProgress,
      apiKey: openRouterKey,
    });

    const estimateByNumber = new Map(
      estimates.map((estimate) => [estimate.issue_number, estimate])
    );
    const seenIssues = new Set<number>();
    const enriched = summaries.reduce<Array<{
      issue_number: number;
      title: string;
      complexity: string;
      estimated_cost: string;
      labels: string;
      url: string;
    }>>((acc, issue) => {
      if (seenIssues.has(issue.number)) {
        return acc;
      }

      const match = estimateByNumber.get(issue.number);
      if (!match) {
        throw new Error(`Missing estimate for issue #${issue.number}`);
      }

      seenIssues.add(issue.number);
      acc.push({
        issue_number: issue.number,
        title: issue.title,
        complexity: String(match.complexity),
        estimated_cost: String(match.estimated_cost),
        labels: issue.labels.join("; "),
        url: issue.url,
      });
      return acc;
    }, []);

    const branchField = needBranchInfo || preferredBranch ? resolvedBranch : undefined;

    updateProgress?.("complete", {
      message: `Generated estimates for ${enriched.length} issue${enriched.length === 1 ? "" : "s"}.`,
    });
    return NextResponse.json({
      estimates: enriched,
      repoTree,
      branch: branchField,
      suggestedPaths: repoTree ? suggestDefaultPaths(repoTree) : undefined,
      hasMore,
      selectedFiles: files.map((file) => ({
        path: file.path,
        language: file.language,
        lines: file.lines,
        sha256: file.hash,
        truncated: file.truncated,
      })),
      fileContextChunks: contexts,
      debugCapturePath: debugPath ?? undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    updateProgress?.("error", { error: message, message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
