"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface IssueEstimate {
  issue_number: number;
  title: string;
  complexity: string;
  estimated_cost: string;
  labels: string;
  url: string;
}

type CachedEstimate = {
  estimates: IssueEstimate[];
  savedAt: number;
  limit: number | null;
};

const STORAGE_KEY = "issue-estimator-cache-v1";

export default function HomePage() {
  const [repoUrl, setRepoUrl] = useState("");
  const [githubToken, setGithubToken] = useState("");
  const [issueLimit, setIssueLimit] = useState("5");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [estimates, setEstimates] = useState<IssueEstimate[]>([]);
  const [cache, setCache] = useState<Record<string, CachedEstimate>>({});
  const [cacheReady, setCacheReady] = useState(false);

  const trimmedRepo = repoUrl.trim();
  const normalizedLimit = useMemo(() => {
    const trimmed = issueLimit.trim();
    if (!trimmed) return undefined;
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
    return Math.max(1, Math.min(100, parsed));
  }, [issueLimit]);

  const cacheKey = trimmedRepo ? `${trimmedRepo}::${normalizedLimit ?? "all"}` : "";
  const cachedResult = cacheKey ? cache[cacheKey] ?? cache[trimmedRepo] : undefined;

  const hasData = estimates.length > 0;

  const csvHref = useMemo(() => {
    if (!hasData) return "";
    const header = "issue_number,title,complexity,estimated_cost,labels,url";
    const rows = estimates.map((issue) =>
      [
        issue.issue_number,
        `"${issue.title.replace(/"/g, '""')}"`,
        issue.complexity,
        issue.estimated_cost,
        `"${issue.labels.replace(/"/g, '""')}"`,
        issue.url,
      ].join(",")
    );
    const csv = [header, ...rows].join("\n");
    return URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  }, [estimates, hasData]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, CachedEstimate>;
        setCache(parsed);
      }
    } catch {
      // ignore invalid cache payloads
    } finally {
      setCacheReady(true);
    }
  }, []);

  useEffect(() => {
    if (!cacheReady || typeof window === "undefined") return;

    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
    } catch {
      // ignore write errors (e.g. storage disabled)
    }
  }, [cache, cacheReady]);

  useEffect(() => {
    return () => {
      if (csvHref) {
        URL.revokeObjectURL(csvHref);
      }
    };
  }, [csvHref]);

  async function runEstimation(options?: { bypassCache?: boolean }) {
    const bypassCache = options?.bypassCache ?? false;
    setIsLoading(true);
    setError(null);
    setNotice(null);

    try {
      if (!trimmedRepo) {
        throw new Error("Please enter a repository URL");
      }

      const existing = cachedResult;
      if (!bypassCache && existing) {
        setEstimates(existing.estimates);
        setNotice(
          `Loaded cached estimates from your previous run${
            existing.limit ? ` (limit ${existing.limit})` : ""
          }.`
        );
        return;
      }

      setEstimates([]);

      const response = await fetch("/api/estimate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          repoUrl: trimmedRepo,
          githubToken,
          issueLimit: normalizedLimit,
        }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error ?? "Unable to generate estimates");
      }

      const payload = (await response.json()) as {
        estimates: IssueEstimate[];
      };
      const nextEstimates = payload.estimates ?? [];
      setEstimates(nextEstimates);
      setCache((prev) => ({
        ...prev,
        [cacheKey || trimmedRepo]: {
          estimates: nextEstimates,
          savedAt: Date.now(),
          limit: normalizedLimit ?? null,
        },
      }));
      setNotice(
        `Estimates updated and cached on this device${
          normalizedLimit ? ` (limit ${normalizedLimit})` : ""
        }.`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unexpected error");
    } finally {
      setIsLoading(false);
    }
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await runEstimation();
  }

  async function handleRefresh() {
    await runEstimation({ bypassCache: true });
  }

  return (
    <main className="container flex min-h-screen flex-col justify-center py-16">
      <div className="space-y-10">
        <header className="space-y-3 text-center">
          <h1 className="text-3xl font-semibold tracking-tight">Issue Estimator</h1>
          <p className="text-sm text-slate-600">
            Minimal tool that scans a GitHub repository, sends the issues to GPT-5 once,
            and returns a CSV with estimated effort and cost.
          </p>
        </header>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700" htmlFor="repoUrl">
              GitHub repository URL
            </label>
            <Input
              id="repoUrl"
              placeholder="https://github.com/org/project"
              value={repoUrl}
              onChange={(event) => setRepoUrl(event.target.value)}
              required
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700" htmlFor="issueLimit">
              Issue limit (optional)
            </label>
            <Input
              id="issueLimit"
              inputMode="numeric"
              pattern="[0-9]*"
              placeholder="Leave blank for all issues"
              value={issueLimit}
              onChange={(event) => setIssueLimit(event.target.value)}
            />
            <p className="text-xs text-slate-500">
              Defaults to 5 issues to keep runs snappy. Remove to process the full queue.
            </p>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700" htmlFor="githubToken">
              GitHub token (optional, increases rate limits)
            </label>
            <Input
              id="githubToken"
              type="password"
              placeholder="ghp_..."
              value={githubToken}
              onChange={(event) => setGithubToken(event.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Button type="submit" disabled={isLoading} className="w-full">
              {isLoading ? "Estimating…" : "Generate CSV"}
            </Button>
            {cachedResult ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleRefresh}
                  disabled={isLoading}
                  className="w-full"
                >
                  Refresh from GitHub
                </Button>
                <p className="text-xs text-slate-500">
                  Cached locally {new Date(cachedResult.savedAt).toLocaleString()}.
                </p>
              </>
            ) : null}
          </div>
        </form>

        {error ? (
          <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-600">
            {error}
          </p>
        ) : null}

        {notice ? (
          <p className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-700">
            {notice}
          </p>
        ) : null}

        {hasData ? (
          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Preview</h2>
              <a
                href={csvHref}
                download="issue-estimates.csv"
                className="text-sm font-medium text-slate-700 hover:underline"
              >
                Download CSV
              </a>
            </div>
            <div className="overflow-hidden rounded-lg border border-slate-200">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50 text-left">
                  <tr>
                    <th className="px-3 py-2 font-medium text-slate-500">#</th>
                    <th className="px-3 py-2 font-medium text-slate-500">Title</th>
                    <th className="px-3 py-2 font-medium text-slate-500">Complexity</th>
                    <th className="px-3 py-2 font-medium text-slate-500">Estimate</th>
                    <th className="px-3 py-2 font-medium text-slate-500">Labels</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {estimates.map((issue) => (
                    <tr key={issue.issue_number} className="hover:bg-slate-50">
                      <td className="px-3 py-2 text-slate-600">
                        <a
                          href={issue.url}
                          target="_blank"
                          rel="noreferrer"
                          className="hover:underline"
                        >
                          #{issue.issue_number}
                        </a>
                      </td>
                      <td className="px-3 py-2 text-slate-700">{issue.title}</td>
                      <td className="px-3 py-2 text-slate-600">{issue.complexity}</td>
                      <td className="px-3 py-2 text-slate-600">{issue.estimated_cost}</td>
                      <td className="px-3 py-2 text-slate-500">{issue.labels}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}
      </div>
    </main>
  );
}
