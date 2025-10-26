import { NextResponse } from "next/server";
import OpenAI from "openai";
import { ProxyAgent, setGlobalDispatcher } from "undici";

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

async function requestEstimates(issueSummaries: IssueSummary[]) {
  const apiKey = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured");
  }

  const client = new OpenAI({ apiKey });

  const systemPrompt = `You are a budgeting assistant. Estimate the complexity and dollar cost of GitHub issues.
Return JSON with an array "estimates" where each entry contains issue_number, complexity (one of Low, Medium, High),
and estimated_cost (a string like "$250"). Use the provided context and keep explanations brief.`;

  const userPrompt = `Here are the issues from a repository. Analyze them collectively and respond with JSON only.
${JSON.stringify(issueSummaries)}
`;

  const response = await client.responses.create({
    model: "gpt-5.0-mini",
    input: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    reasoning: {
      effort: "minimal"
    }
  });

  const text =
    response.output_text ??
    response.output
      ?.map((item) =>
        item.content
          ?.map((piece) => (piece.type === "output_text" ? piece.text : ""))
          .join("") ?? ""
      )
      .join("") ??
    "";
  if (!text) {
    throw new Error("OpenAI response was empty");
  }

  try {
    const parsed = JSON.parse(text) as {
      estimates: Array<{
        issue_number: number;
        complexity: string;
        estimated_cost: string;
      }>;
    };
    return parsed.estimates ?? [];
  } catch (error) {
    throw new Error("Unable to parse OpenAI response");
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

    if (!repoUrl) {
      return NextResponse.json({ error: "Repository URL is required" }, { status: 400 });
    }

    const parsed = parseGitHubUrl(repoUrl);
    if (!parsed) {
      return NextResponse.json({ error: "Invalid GitHub repository URL" }, { status: 400 });
    }

    const issues = await fetchAllIssues(parsed.owner, parsed.repo, githubToken, issueLimit);
    if (issues.length === 0) {
      return NextResponse.json({ estimates: [] });
    }

    const summaries = await buildIssuesPayload(issues, githubToken);
    const estimates = await requestEstimates(summaries);

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

    return NextResponse.json({ estimates: enriched });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
