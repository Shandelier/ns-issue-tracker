import { NextResponse } from "next/server";
import OpenAI from "openai";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import { createHash } from "crypto";
import { extname } from "path";

const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
}

export const runtime = "nodejs";

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

async function fetchJson<T>(url: string, githubToken?: string) {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "issue-estimator",
  };
  const token = githubToken || process.env.GITHUB_TOKEN;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const response = await fetch(url, { headers });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(`GitHub request failed: ${response.status} ${message}`);
  }
  return (await response.json()) as T;
}

async function fetchAllIssues(
  owner: string,
  repo: string,
  githubToken?: string,
  limit?: number
): Promise<GitHubIssue[]> {
  const issues: GitHubIssue[] = [];
  let page = 1;
  const cappedLimit = limit && Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : undefined;

  while (true) {
    const batch = await fetchJson<GitHubIssue[]>(
      `https://api.github.com/repos/${owner}/${repo}/issues?state=open&per_page=100&page=${page}`,
      githubToken
    );

    if (batch.length === 0) break;
    const filtered = batch.filter((issue: any) => !issue.pull_request);
    issues.push(...filtered);

    if (cappedLimit && issues.length >= cappedLimit) {
      return issues.slice(0, cappedLimit);
    }
    if (batch.length < 100) break;
    page += 1;
  }

  return issues;
}

async function fetchIssueComments(
  issue: GitHubIssue,
  githubToken?: string
): Promise<string[]> {
  if (!issue.comments) {
    return [];
  }

  const comments = await fetchJson<GitHubComment[]>(
    `${issue.comments_url}?per_page=20`,
    githubToken
  );

  return comments
    .map((comment) => comment.body?.trim())
    .filter((body): body is string => Boolean(body))
    .slice(0, 5);
}

async function fetchRepoInfo(owner: string, repo: string, githubToken?: string) {
  return await fetchJson<GitHubRepo>(`https://api.github.com/repos/${owner}/${repo}`, githubToken);
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
  return await fetchJson<GitHubContentFile[] | GitHubContentFile>(
    `https://api.github.com/repos/${owner}/${repo}/contents${suffix}${refParam}`,
    githubToken
  );
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
  const response = await fetchJson<GitHubContentFile>(
    `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}${refParam}`,
    githubToken
  );

  if (response.type !== "file" || !response.content) {
    return null;
  }

  const buffer = Buffer.from(response.content, response.encoding ?? "base64");
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

  return {
    contexts: files.map(formatFileContext),
    files,
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
      return {
        number: issue.number,
        title: issue.title,
        body: issue.body ?? "",
        labels: labels.filter(Boolean),
        comments,
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

async function requestEstimates(issueSummaries: IssueSummary[], fileContexts: string[]) {
  const apiKey =
    process.env.OPENROUTER_API_KEY ||
    process.env.OPENROUTER_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.OPENAI_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not configured");
  }

  const systemPrompt = `You are a budgeting assistant. Estimate the complexity and dollar cost of GitHub issues.
Return JSON with an array "estimates" where each entry contains issue_number, complexity (one of Low, Medium, High),
and estimated_cost (a string like "$250"). Use the provided context and keep explanations brief.`;

  const issuesSection = `Here are the issues from a repository. Analyze them collectively and respond with JSON only.
${JSON.stringify(issueSummaries)}`;

  const filesSection = fileContexts.length
    ? `\n\nHere is additional repository context:\n${fileContexts.join("\n\n")}`
    : "";

  const userPrompt = `${issuesSection}${filesSection}
`;

  const referer = process.env.OPENROUTER_SITE_URL;
  const title = process.env.OPENROUTER_APP_TITLE || process.env.OPENROUTER_APP_NAME;

  const defaultHeaders: Record<string, string> = {};
  if (referer) {
    defaultHeaders["HTTP-Referer"] = referer;
  }
  if (title) {
    defaultHeaders["X-Title"] = title;
  }

  const model = process.env.OPENROUTER_MODEL || "x-ai/grok-code-fast-1";

  const client = new OpenAI({
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
    defaultHeaders: Object.keys(defaultHeaders).length ? defaultHeaders : undefined,
  });

  const response = await client.chat.completions.create({
    model,
    temperature: 0.2,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  const content = response.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("OpenRouter response was empty");
  }

  try {
    const parsed = coerceJsonPayload(content) as {
      estimates?: Array<{
        issue_number: number;
        complexity: string;
        estimated_cost: string;
      }>;
    };
    return parsed.estimates ?? [];
  } catch (error) {
    throw new Error("Unable to parse OpenRouter response");
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const repoUrl: string | undefined = body?.repoUrl;
    const githubToken: string | undefined = body?.githubToken;
    const rawIssueLimit = body?.issueLimit;
    const issueLimit =
      typeof rawIssueLimit === "number" && Number.isFinite(rawIssueLimit)
        ? Math.max(1, Math.min(100, Math.floor(rawIssueLimit)))
        : undefined;
    const listRepoFiles = Boolean(body?.includeRepoTree);
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
    const preferredBranch =
      typeof body?.branch === "string" && body.branch.trim().length > 0
        ? body.branch.trim()
        : undefined;
    const needBranchInfo = listRepoFiles || selectedPaths.length > 0;

    if (!repoUrl) {
      return NextResponse.json({ error: "Repository URL is required" }, { status: 400 });
    }

    const parsed = parseGitHubUrl(repoUrl);
    if (!parsed) {
      return NextResponse.json({ error: "Invalid GitHub repository URL" }, { status: 400 });
    }

    const issues = await fetchAllIssues(parsed.owner, parsed.repo, githubToken, issueLimit);
    if (issues.length === 0) {
      const emptyResponse: Record<string, unknown> = { estimates: [] };
      if (listRepoFiles) {
        let branchRef = preferredBranch;
        if (!branchRef) {
          const repoInfo = await fetchRepoInfo(parsed.owner, parsed.repo, githubToken);
          branchRef = repoInfo.default_branch ?? "main";
        }
        const repoTree = await fetchRepoTree(
          parsed.owner,
          parsed.repo,
          githubToken,
          treeDepth,
          branchRef
        );
        emptyResponse.repoTree = repoTree;
        emptyResponse.branch = branchRef;
      }
      return NextResponse.json(emptyResponse);
    }

    let branchRef = preferredBranch;
    if (!branchRef && needBranchInfo) {
      const repoInfo = await fetchRepoInfo(parsed.owner, parsed.repo, githubToken);
      branchRef = repoInfo.default_branch ?? "main";
    }

    const repoTreePromise = listRepoFiles
      ? fetchRepoTree(parsed.owner, parsed.repo, githubToken, treeDepth, branchRef)
      : Promise.resolve<RepoTreeNode[] | undefined>(undefined);

    const fileContextsPromise = selectedPaths.length
      ? buildFileContexts(parsed.owner, parsed.repo, selectedPaths, githubToken, branchRef)
      : Promise.resolve({ contexts: [] as string[], files: [] as FileContext[] });

    const summaries = await buildIssuesPayload(issues, githubToken);
    const [{ contexts, files }, repoTree] = await Promise.all([fileContextsPromise, repoTreePromise]);
    const estimates = await requestEstimates(summaries, contexts);

    const enriched = summaries.map((issue) => {
      const match = estimates.find((estimate) => estimate.issue_number === issue.number);
      if (!match) {
        throw new Error(`Missing estimate for issue #${issue.number}`);
      }

      return {
        issue_number: issue.number,
        title: issue.title,
        complexity: String(match.complexity),
        estimated_cost: String(match.estimated_cost),
        labels: issue.labels.join("; "),
        url: issue.url,
      };
    });

    return NextResponse.json({
      estimates: enriched,
      repoTree,
      branch: branchRef,
      selectedFiles: files.map((file) => ({
        path: file.path,
        language: file.language,
        lines: file.lines,
        sha256: file.hash,
        truncated: file.truncated,
      })),
      fileContextChunks: contexts,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
