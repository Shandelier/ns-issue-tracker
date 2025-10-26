"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

interface RepoTreeNode {
  path: string;
  name: string;
  type: "file" | "dir";
  size?: number;
  sha?: string;
  children?: RepoTreeNode[];
}

interface SelectedFileMeta {
  path: string;
  language: string;
  lines: number;
  sha256: string;
  truncated: boolean;
}

type CachedEstimate = {
  estimates: IssueEstimate[];
  savedAt: number;
  limit: number | null;
  selectedPaths: string[];
  branch?: string;
  selectedFiles?: SelectedFileMeta[];
};

type EstimateResponse = {
  estimates: IssueEstimate[];
  repoTree?: RepoTreeNode[];
  branch?: string;
  suggestedPaths?: string[];
  selectedFiles?: SelectedFileMeta[];
  fileContextChunks?: string[];
};

const STORAGE_KEY = "issue-estimator-cache-v2";
const DEFAULT_ISSUE_LIMIT = "5";
const MAX_SELECTED_FILES = 25;

const sortPaths = (paths: string[]) => [...paths].sort((a, b) => a.localeCompare(b));

function treeHasSelection(node: RepoTreeNode, selectedSet: Set<string>): boolean {
  if (selectedSet.has(node.path)) {
    return true;
  }
  if (node.type === "dir" && Array.isArray(node.children)) {
    return node.children.some((child) => treeHasSelection(child, selectedSet));
  }
  return false;
}

function sanitizeId(path: string) {
  return `repo-tree-${path.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

type RepoTreeViewProps = {
  nodes: RepoTreeNode[];
  selectedPaths: string[];
  onToggle: (path: string, type: "file" | "dir") => void;
  disabled?: boolean;
};

function RepoTreeView({ nodes, selectedPaths, onToggle, disabled }: RepoTreeViewProps) {
  const selectedSet = useMemo(() => new Set(selectedPaths), [selectedPaths]);

  return (
    <ul className="space-y-1">
      {nodes.map((node) => (
        <RepoTreeItem
          key={node.path}
          node={node}
          depth={0}
          selectedSet={selectedSet}
          onToggle={onToggle}
          disabled={disabled}
        />
      ))}
    </ul>
  );
}

type RepoTreeItemProps = {
  node: RepoTreeNode;
  depth: number;
  selectedSet: Set<string>;
  onToggle: (path: string, type: "file" | "dir") => void;
  disabled?: boolean;
};

function RepoTreeItem({ node, depth, selectedSet, onToggle, disabled }: RepoTreeItemProps) {
  const checkboxRef = useRef<HTMLInputElement>(null);
  const hasChildren = node.type === "dir" && Array.isArray(node.children) && node.children.length > 0;
  const isSelected = selectedSet.has(node.path);
  const hasDescendantSelection =
    hasChildren && node.children ? node.children.some((child) => treeHasSelection(child, selectedSet)) : false;
  const isIndeterminate = !isSelected && hasDescendantSelection;
  const checkboxId = sanitizeId(node.path);

  useEffect(() => {
    if (checkboxRef.current) {
      checkboxRef.current.indeterminate = isIndeterminate;
    }
  }, [isIndeterminate]);

  const label = node.type === "dir" ? `${node.name}/` : node.name;

  return (
    <li>
      <div
        className="flex items-center gap-2"
        style={{ paddingLeft: depth > 0 ? `${depth * 1.25}rem` : undefined }}
      >
        <input
          id={checkboxId}
          ref={checkboxRef}
          type="checkbox"
          className="h-4 w-4"
          checked={isSelected}
          disabled={disabled}
          onChange={() => onToggle(node.path, node.type)}
        />
        <label
          htmlFor={checkboxId}
          className={`flex items-center gap-2 text-sm ${
            node.type === "dir" ? "font-medium text-slate-700" : "text-slate-600"
          }`}
          title={node.path}
        >
          <span>{label}</span>
          <span className="text-xs text-slate-400">{node.type === "dir" ? "folder" : "file"}</span>
        </label>
      </div>
      {hasChildren ? (
        <ul className="space-y-1">
          {node.children!.map((child) => (
            <RepoTreeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedSet={selectedSet}
              onToggle={onToggle}
              disabled={disabled}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export default function HomePage() {
  const [repoUrl, setRepoUrl] = useState("");
  const [githubToken, setGithubToken] = useState("");
  const [issueLimit, setIssueLimit] = useState(DEFAULT_ISSUE_LIMIT);
  const [repoTree, setRepoTree] = useState<RepoTreeNode[]>([]);
  const [branch, setBranch] = useState<string | undefined>(undefined);
  const [suggestedPaths, setSuggestedPaths] = useState<string[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [selectedFilesMeta, setSelectedFilesMeta] = useState<SelectedFileMeta[]>([]);
  const [estimates, setEstimates] = useState<IssueEstimate[]>([]);
  const [cache, setCache] = useState<Record<string, CachedEstimate>>({});
  const [cacheReady, setCacheReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isRepoLoaded, setIsRepoLoaded] = useState(false);
  const [loadingAction, setLoadingAction] = useState<"load-repo" | "estimate" | null>(null);

  const trimmedRepo = repoUrl.trim();

  const normalizedLimit = useMemo(() => {
    const trimmed = issueLimit.trim();
    if (!trimmed) return undefined;
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
    return Math.max(1, Math.min(100, parsed));
  }, [issueLimit]);

  const sortedSelection = useMemo(() => sortPaths(selectedPaths), [selectedPaths]);
  const effectiveSelection = useMemo(
    () => sortedSelection.slice(0, MAX_SELECTED_FILES),
    [sortedSelection]
  );
  const selectionTrimmed = sortedSelection.length > effectiveSelection.length;
  const selectionKey = useMemo(
    () => (effectiveSelection.length ? effectiveSelection.join("|") : "none"),
    [effectiveSelection]
  );

  const branchKey = branch && branch.length ? branch : "default";
  const limitKey = normalizedLimit ?? "all";
  const cacheKey = trimmedRepo ? `${trimmedRepo}::${branchKey}::${selectionKey}::${limitKey}` : "";
  const cachedResult = cacheKey ? cache[cacheKey] : undefined;

  const hasData = estimates.length > 0;
  const isLoadingRepo = loadingAction === "load-repo";
  const isEstimating = loadingAction === "estimate";

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
      if (!raw) {
        setCacheReady(true);
        return;
      }

      const parsed = JSON.parse(raw) as Record<string, CachedEstimate>;
      const sanitized: Record<string, CachedEstimate> = {};

      for (const [key, value] of Object.entries(parsed)) {
        if (!value || !Array.isArray(value.estimates)) continue;
        const cleanedSelectedPaths = Array.isArray(value.selectedPaths)
          ? sortPaths(
              value.selectedPaths.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
            )
          : [];
        sanitized[key] = {
          estimates: value.estimates,
          savedAt: typeof value.savedAt === "number" ? value.savedAt : Date.now(),
          limit: typeof value.limit === "number" && Number.isFinite(value.limit) ? value.limit : null,
          selectedPaths: cleanedSelectedPaths,
          branch: typeof value.branch === "string" ? value.branch : undefined,
          selectedFiles: Array.isArray(value.selectedFiles) ? value.selectedFiles : undefined,
        };
      }

      setCache(sanitized);
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
      // ignore storage write errors
    }
  }, [cache, cacheReady]);

  useEffect(() => {
    return () => {
      if (csvHref) {
        URL.revokeObjectURL(csvHref);
      }
    };
  }, [csvHref]);

  const handleTogglePath = useCallback((path: string, type: "file" | "dir") => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
        if (type === "dir") {
          for (const entry of Array.from(next)) {
            if (entry !== path && entry.startsWith(`${path}/`)) {
              next.delete(entry);
            }
          }
        } else {
          for (const entry of Array.from(next)) {
            if (entry !== path && path.startsWith(`${entry}/`)) {
              next.delete(entry);
            }
          }
        }
      }
      return sortPaths(Array.from(next));
    });
  }, []);

  const handleUseSuggested = useCallback(() => {
    setSelectedPaths(sortPaths(suggestedPaths));
  }, [suggestedPaths]);

  const handleClearSelection = useCallback(() => {
    setSelectedPaths([]);
  }, []);

  const handleLoadRepository = useCallback(
    async (event?: React.FormEvent<HTMLFormElement>) => {
      event?.preventDefault();
      if (!trimmedRepo) {
        setError("Please enter a repository URL");
        return;
      }

      setLoadingAction("load-repo");
      setError(null);
      setNotice(null);

      try {
        const response = await fetch("/api/estimate", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            repoUrl: trimmedRepo,
            githubToken,
            includeRepoTree: true,
            onlyRepoTree: true,
            treeDepth: 3,
          }),
        });

        if (!response.ok) {
          const payload = await response.json().catch(() => null);
          throw new Error(payload?.error ?? "Unable to load repository metadata");
        }

        const payload = (await response.json()) as {
          repoTree?: RepoTreeNode[];
          branch?: string;
          suggestedPaths?: string[];
        };

        const nextTree = payload.repoTree ?? [];
        const nextSuggested = payload.suggestedPaths ?? [];

        setRepoTree(nextTree);
        setSuggestedPaths(nextSuggested);
        setSelectedPaths(sortPaths(nextSuggested));
        setBranch(payload.branch);
        setIsRepoLoaded(true);
        setEstimates([]);
        setSelectedFilesMeta([]);
        setNotice(
          nextSuggested.length
            ? `Repository loaded. Preselected ${nextSuggested.length} context files.`
            : "Repository loaded. Select context files to include."
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unexpected error while loading repository");
      } finally {
        setLoadingAction(null);
      }
    },
    [githubToken, trimmedRepo]
  );

  const runEstimation = useCallback(
    async (options?: { bypassCache?: boolean }) => {
      const bypassCache = options?.bypassCache ?? false;

      if (!trimmedRepo) {
        setError("Please enter a repository URL");
        return;
      }
      if (!isRepoLoaded) {
        setError("Load the repository before estimating issues");
        return;
      }

      if (!bypassCache && cachedResult) {
        setEstimates(cachedResult.estimates);
        setSelectedFilesMeta(cachedResult.selectedFiles ?? []);
        setNotice(`Loaded cached estimates from ${new Date(cachedResult.savedAt).toLocaleString()}.`);
        return;
      }

      setLoadingAction("estimate");
      setError(null);
      setNotice(null);

      try {
        const response = await fetch("/api/estimate", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            repoUrl: trimmedRepo,
            githubToken,
            issueLimit: normalizedLimit,
            selectedPaths: effectiveSelection,
            branch,
          }),
        });

        if (!response.ok) {
          const payload = await response.json().catch(() => null);
          throw new Error(payload?.error ?? "Unable to generate estimates");
        }

        const payload = (await response.json()) as EstimateResponse;
        const nextEstimates = payload.estimates ?? [];

        setEstimates(nextEstimates);
        setSelectedFilesMeta(Array.isArray(payload.selectedFiles) ? payload.selectedFiles : []);
        if (Array.isArray(payload.repoTree) && payload.repoTree.length > 0) {
          setRepoTree(payload.repoTree);
          if (Array.isArray(payload.suggestedPaths)) {
            setSuggestedPaths(payload.suggestedPaths);
          }
        }
        if (payload.branch) {
          setBranch(payload.branch);
        }

        if (cacheKey) {
          setCache((prev) => ({
            ...prev,
            [cacheKey]: {
              estimates: nextEstimates,
              savedAt: Date.now(),
              limit: normalizedLimit ?? null,
              selectedPaths: effectiveSelection,
              branch: payload.branch ?? branch,
              selectedFiles: payload.selectedFiles,
            },
          }));
        }

        setNotice(
          `Estimates updated${selectionTrimmed ? " (first 25 selections applied)" : ""}.`
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unexpected error while estimating issues");
      } finally {
        setLoadingAction(null);
      }
    },
    [
      branch,
      cacheKey,
      cachedResult,
      effectiveSelection,
      githubToken,
      isRepoLoaded,
      normalizedLimit,
      selectionTrimmed,
      trimmedRepo,
    ]
  );

  const handleEstimateSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      await runEstimation();
    },
    [runEstimation]
  );

  const handleRefresh = useCallback(async () => {
    await runEstimation({ bypassCache: true });
  }, [runEstimation]);

  const selectionSummary = useMemo(() => {
    if (!sortedSelection.length) {
      return "No files or folders selected yet.";
    }
    const preview = sortedSelection.slice(0, 6);
    const suffix =
      sortedSelection.length > preview.length
        ? `, and ${sortedSelection.length - preview.length} more`
        : "";
    return `${preview.join(", ")}${suffix}`;
  }, [sortedSelection]);

  const issueCountDescription = normalizedLimit
    ? `${normalizedLimit} issue${normalizedLimit === 1 ? "" : "s"}`
    : "All open issues";

  return (
    <main className="container max-w-4xl space-y-10 py-16">
      <header className="space-y-3 text-center">
        <h1 className="text-3xl font-semibold tracking-tight">Issue Estimator</h1>
        <p className="text-sm text-slate-600">
          Load a GitHub repo, pick the most representative files, and let the estimator score the
          newest issues.
        </p>
      </header>

      <section className="space-y-6 rounded-lg border border-slate-200 p-6 shadow-sm">
        <h2 className="text-lg font-semibold">1. Connect a repository</h2>
        <form onSubmit={handleLoadRepository} className="space-y-4">
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
            <p className="text-xs text-slate-500">
              A token avoids GitHub&apos;s low anonymous rate limits. It is never stored.
            </p>
          </div>

          <Button type="submit" disabled={isLoadingRepo} className="w-full sm:w-auto">
            {isLoadingRepo ? "Loading repository…" : "Load repository"}
          </Button>
        </form>
        {branch ? (
          <p className="text-xs text-slate-500">Using branch: {branch}</p>
        ) : null}
      </section>

      {isRepoLoaded ? (
        <section className="space-y-4 rounded-lg border border-slate-200 p-6 shadow-sm">
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-semibold">2. Choose context files</h2>
            <p className="text-sm text-slate-600">
              Select files or folders (depth limited to three levels). These will be embedded into
              the LLM prompt before estimating issues.
            </p>
            {selectionTrimmed ? (
              <p className="text-xs text-amber-600">
                You selected more than {MAX_SELECTED_FILES} entries. Only the first {MAX_SELECTED_FILES} will be sent.
              </p>
            ) : null}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleUseSuggested}
              disabled={isEstimating || suggestedPaths.length === 0}
            >
              Use suggested files
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleClearSelection}
              disabled={isEstimating || sortedSelection.length === 0}
            >
              Clear selection
            </Button>
          </div>

          <div className="overflow-hidden rounded-md border border-slate-200 bg-white p-3">
            {repoTree.length ? (
              <RepoTreeView
                nodes={repoTree}
                selectedPaths={sortedSelection}
                onToggle={handleTogglePath}
                disabled={isEstimating}
              />
            ) : (
              <p className="text-sm text-slate-500">No files detected in the repository.</p>
            )}
          </div>

          <div className="space-y-1">
            <p className="text-sm font-medium text-slate-700">
              Selected items: {sortedSelection.length}
            </p>
            <p className="break-words text-xs text-slate-500">{selectionSummary}</p>
          </div>
        </section>
      ) : null}

      {isRepoLoaded ? (
        <section className="space-y-4 rounded-lg border border-slate-200 p-6 shadow-sm">
          <h2 className="text-lg font-semibold">3. Estimate issues</h2>
          <form onSubmit={handleEstimateSubmit} className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700" htmlFor="issueLimit">
                How many open issues? (default 5)
              </label>
              <Input
                id="issueLimit"
                inputMode="numeric"
                pattern="[0-9]*"
                value={issueLimit}
                onChange={(event) => setIssueLimit(event.target.value)}
              />
              <p className="text-xs text-slate-500">
                Issues are pulled newest-first. Increase the number for a broader sweep.
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={isEstimating} className="w-full sm:w-auto">
                {isEstimating ? "Estimating issues…" : "Generate estimates"}
              </Button>
              {cachedResult ? (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleRefresh}
                    disabled={isEstimating}
                  >
                    Refresh from GitHub
                  </Button>
                  <p className="text-xs text-slate-500">
                    Cached on {new Date(cachedResult.savedAt).toLocaleString()}.
                  </p>
                </>
              ) : null}
            </div>
          </form>
        </section>
      ) : null}

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
        <section className="space-y-6 rounded-lg border border-slate-200 p-6 shadow-sm">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="text-lg font-semibold">4. Review estimates</h2>
              <p className="text-sm text-slate-600">
                {issueCountDescription} analyzed using {selectedFilesMeta.length} {selectedFilesMeta.length === 1 ? "context file" : "context files"}.
              </p>
            </div>
            <a
              href={csvHref}
              download="issue-estimates.csv"
              className="inline-flex items-center justify-center rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Download CSV
            </a>
          </div>

          {selectedFilesMeta.length ? (
            <div className="space-y-2">
              <p className="text-sm font-medium text-slate-700">Context files sent to the model</p>
              <ul className="space-y-1 text-sm text-slate-600">
                {selectedFilesMeta.map((file) => (
                  <li key={file.path} className="flex flex-wrap gap-3">
                    <span className="font-mono text-xs text-slate-500">{file.path}</span>
                    <span className="text-xs text-slate-500">
                      {file.language} · {file.lines} lines · sha256:{file.sha256}
                      {file.truncated ? " · truncated" : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
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
    </main>
  );
}
