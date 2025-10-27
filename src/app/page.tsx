"use client";

import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { loadSettingsFromStorage } from "@/lib/settings";

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
  model?: string;
};

type EstimateResponse = {
  estimates: IssueEstimate[];
  repoTree?: RepoTreeNode[];
  branch?: string;
  suggestedPaths?: string[];
  selectedFiles?: SelectedFileMeta[];
  fileContextChunks?: string[];
  debugCapturePath?: string | null;
  hasMore?: boolean;
};

type RemoteProgressSnapshot = {
  id: string;
  stage: string;
  label: string;
  hint?: string | null;
  message?: string | null;
  value: number;
  startedAt: number;
  updatedAt: number;
  error?: string | null;
};

const STORAGE_KEY = "issue-estimator-cache-v2";
const DEFAULT_ISSUE_LIMIT = "";
const ISSUE_BATCH_SIZE = 5;
const MAX_SELECTED_FILES = 25;
const DEBUG_CAPTURE_STORAGE_KEY = "issue-estimator-debug-capture";

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
  const [authorized, setAuthorized] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
  const [authPassword, setAuthPassword] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [repoUrl, setRepoUrl] = useState("");
  const [githubToken, setGithubToken] = useState("");
  const [issueLimit, setIssueLimit] = useState(DEFAULT_ISSUE_LIMIT);
  const [includeAllIssues, setIncludeAllIssues] = useState(true);
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
  const [debugCaptureEnabled, setDebugCaptureEnabled] = useState(false);
  const [debugCapturePath, setDebugCapturePath] = useState<string | null>(null);
  const [debugCopyState, setDebugCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [openRouterModel, setOpenRouterModel] = useState<string | null>(null);
  const debugCopyTimeoutRef = useRef<number | null>(null);
  const progressStartRef = useRef<number | null>(null);
  const [progressElapsedMs, setProgressElapsedMs] = useState(0);
  const [progressSnapshot, setProgressSnapshot] = useState<RemoteProgressSnapshot | null>(null);
  const [activeProgressId, setActiveProgressId] = useState<string | null>(null);
  const progressPollRef = useRef<number | null>(null);

  const trimmedRepo = repoUrl.trim();

  const normalizedLimit = useMemo(() => {
    if (includeAllIssues) return undefined;
    const trimmed = issueLimit.trim();
    if (!trimmed) return undefined;
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
    return Math.max(1, Math.min(100, parsed));
  }, [includeAllIssues, issueLimit]);

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
  const modelKey = openRouterModel ?? "env";
  const cacheKey = trimmedRepo
    ? `${trimmedRepo}::${branchKey}::${selectionKey}::${limitKey}::${modelKey}`
    : "";
  const cachedResult = cacheKey ? cache[cacheKey] : undefined;

  const hasData = estimates.length > 0;
  const isLoadingRepo = loadingAction === "load-repo";
  const isEstimating = loadingAction === "estimate";

  const progressValue = useMemo(() => {
    if (!loadingAction) return 0;
    if (loadingAction === "estimate" && progressSnapshot) {
      const percent = Math.round(progressSnapshot.value * 100);
      return Math.min(Math.max(percent, 5), 100);
    }
    const target = loadingAction === "estimate" ? 45_000 : 12_000;
    const computed = (progressElapsedMs / target) * 100;
    const capped = Math.min(computed, 95);
    return Math.max(8, capped);
  }, [loadingAction, progressElapsedMs, progressSnapshot]);

  const progressElapsedLabel = useMemo(() => {
    if (!loadingAction) return "";
    if (progressElapsedMs < 900) {
      return "<1s elapsed";
    }
    if (progressElapsedMs < 60_000) {
      return `${(progressElapsedMs / 1000).toFixed(1)}s elapsed`;
    }
    const minutes = Math.floor(progressElapsedMs / 60_000);
    const seconds = Math.floor((progressElapsedMs % 60_000) / 1000);
    return `${minutes}m ${seconds.toString().padStart(2, "0")}s elapsed`;
  }, [loadingAction, progressElapsedMs]);

  const progressLabel = useMemo(() => {
    if (loadingAction === "estimate") {
      return progressSnapshot?.label ?? "Estimating issues…";
    }
    if (loadingAction === "load-repo") {
      return "Loading repository…";
    }
    return "";
  }, [loadingAction, progressSnapshot]);

  const progressHint = useMemo(() => {
    if (loadingAction === "estimate") {
      return progressSnapshot?.hint ?? "Fetching GitHub data and waiting for the LLM response. Large batches may take a bit.";
    }
    if (loadingAction === "load-repo") {
      return "Collecting repository metadata and suggested context files.";
    }
    return "";
  }, [loadingAction, progressSnapshot]);

  const progressMessage = useMemo(() => {
    if (loadingAction === "estimate") {
      return progressSnapshot?.message ?? "";
    }
    return "";
  }, [loadingAction, progressSnapshot]);

  const progressCard = loadingAction ? (
    <section className="space-y-4 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <span className="text-sm font-semibold text-slate-700">{progressLabel}</span>
        {progressElapsedLabel ? (
          <span className="text-xs text-slate-500">{progressElapsedLabel}</span>
        ) : null}
      </div>
      <Progress value={progressValue} />
      {progressHint ? <p className="text-xs text-slate-500">{progressHint}</p> : null}
      {progressMessage && progressMessage !== progressHint ? (
        <p className="text-xs text-slate-500">{progressMessage}</p>
      ) : null}
    </section>
  ) : null;

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
    let active = true;
    const verify = async () => {
      try {
        const response = await fetch("/api/auth", { credentials: "include" });
        if (!response.ok) {
          throw new Error("Authentication is not available");
        }
        const payload = (await response.json()) as { authorized?: boolean };
        if (!active) return;
        setAuthorized(Boolean(payload.authorized));
        setAuthError(null);
      } catch (error) {
        if (!active) return;
        setAuthorized(false);
        setAuthError(
          error instanceof Error ? error.message : "Unable to verify authentication"
        );
      } finally {
        if (active) {
          setAuthChecked(true);
        }
      }
    };
    verify();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const stored = loadSettingsFromStorage();
    if (!stored) {
      return;
    }
    if (stored.githubToken) {
      setGithubToken(stored.githubToken);
    }
    if (stored.model) {
      setOpenRouterModel(stored.model);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const stored = window.localStorage.getItem(DEBUG_CAPTURE_STORAGE_KEY);
    if (stored) {
      setDebugCaptureEnabled(stored === "true");
    }
  }, []);

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
        const storedModel =
          typeof value.model === "string" && value.model.length > 0 ? value.model : undefined;
        sanitized[key] = {
          estimates: value.estimates,
          savedAt: typeof value.savedAt === "number" ? value.savedAt : Date.now(),
          limit: typeof value.limit === "number" && Number.isFinite(value.limit) ? value.limit : null,
          selectedPaths: cleanedSelectedPaths,
          branch: typeof value.branch === "string" ? value.branch : undefined,
          selectedFiles: Array.isArray(value.selectedFiles) ? value.selectedFiles : undefined,
          ...(storedModel ? { model: storedModel } : {}),
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
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        DEBUG_CAPTURE_STORAGE_KEY,
        debugCaptureEnabled ? "true" : "false"
      );
    } catch {
      // ignore storage write errors
    }
  }, [debugCaptureEnabled]);

  useEffect(() => {
    if (debugCopyTimeoutRef.current !== null) {
      window.clearTimeout(debugCopyTimeoutRef.current);
      debugCopyTimeoutRef.current = null;
    }
    setDebugCopyState("idle");
    if (!debugCaptureEnabled) {
      setDebugCapturePath(null);
    }
  }, [debugCaptureEnabled]);

  useEffect(() => {
    if (debugCopyTimeoutRef.current !== null) {
      window.clearTimeout(debugCopyTimeoutRef.current);
      debugCopyTimeoutRef.current = null;
    }
    setDebugCopyState("idle");
  }, [debugCapturePath]);

  useEffect(() => {
    return () => {
      if (debugCopyTimeoutRef.current !== null) {
        window.clearTimeout(debugCopyTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      if (csvHref) {
        URL.revokeObjectURL(csvHref);
      }
    };
  }, [csvHref]);

  useEffect(() => {
    if (!loadingAction) {
      progressStartRef.current = null;
      setProgressElapsedMs(0);
      return;
    }

    progressStartRef.current = Date.now();

    const updateElapsed = () => {
      if (progressStartRef.current !== null) {
        setProgressElapsedMs(Date.now() - progressStartRef.current);
      }
    };

    updateElapsed();
    const intervalId = window.setInterval(updateElapsed, 250);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [loadingAction]);

  useEffect(() => {
    if (!activeProgressId || typeof window === "undefined") {
      if (progressPollRef.current !== null) {
        window.clearInterval(progressPollRef.current);
        progressPollRef.current = null;
      }
      setProgressSnapshot(null);
      return;
    }

    let disposed = false;
    let fetching = false;

    setProgressSnapshot(null);

    const fetchProgress = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const response = await fetch(`/api/progress/${encodeURIComponent(activeProgressId)}`, {
          cache: "no-store",
        });
        if (response.status === 204) {
          if (!disposed) {
            setProgressSnapshot(null);
          }
          return;
        }
        if (!response.ok) {
          return;
        }
        const payload = (await response.json()) as RemoteProgressSnapshot;
        if (!disposed) {
          setProgressSnapshot(payload);
        }
      } catch {
        // ignore polling errors
      } finally {
        fetching = false;
      }
    };

    fetchProgress();
    progressPollRef.current = window.setInterval(fetchProgress, 1000);

    return () => {
      disposed = true;
      if (progressPollRef.current !== null) {
        window.clearInterval(progressPollRef.current);
        progressPollRef.current = null;
      }
    };
  }, [activeProgressId]);

  const handlePasswordChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      if (authError) {
        setAuthError(null);
      }
      setAuthPassword(event.target.value);
    },
    [authError]
  );

  const handlePasswordSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!authPassword.trim()) {
        setAuthError("Password is required");
        return;
      }

      setAuthLoading(true);
      setAuthError(null);

      try {
        const response = await fetch("/api/auth", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ password: authPassword }),
          credentials: "include",
        });

        if (!response.ok) {
          const payload = await response.json().catch(() => null);
          throw new Error(payload?.error ?? "Invalid password");
        }

        setAuthorized(true);
        setAuthPassword("");
      } catch (error) {
        setAuthorized(false);
        setAuthError(error instanceof Error ? error.message : "Unable to authenticate");
      } finally {
        setAuthLoading(false);
        setAuthChecked(true);
      }
    },
    [authPassword]
  );

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

  const handleIncludeAllToggle = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const nextIncludeAll = event.target.checked;
      setIncludeAllIssues(nextIncludeAll);
      if (nextIncludeAll) {
        setError(null);
      }
    },
    [setError]
  );

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
          credentials: "include",
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
      let requestProgressId: string | null = null;

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
        setDebugCapturePath(null);
        setActiveProgressId(null);
        setProgressSnapshot(null);
        return;
      }

      if (typeof window !== "undefined" && typeof window.crypto?.randomUUID === "function") {
        requestProgressId = window.crypto.randomUUID();
        setActiveProgressId(requestProgressId);
      } else {
        setActiveProgressId(null);
      }
      setProgressSnapshot(null);

      setLoadingAction("estimate");
      setError(null);
      setNotice(null);
      setDebugCapturePath(null);

      try {
        const baseRequestBody: Record<string, unknown> = {
          repoUrl: trimmedRepo,
          githubToken,
          selectedPaths: effectiveSelection,
          branch,
          debugCapture: debugCaptureEnabled,
        };
        if (openRouterModel) {
          baseRequestBody.model = openRouterModel;
        }
        if (requestProgressId) {
          baseRequestBody.progressId = requestProgressId;
        }

        const aggregatedEstimates: IssueEstimate[] = [];
        let aggregatedSelectedFiles: SelectedFileMeta[] | undefined;
        let aggregatedRepoTree: RepoTreeNode[] | undefined;
        let aggregatedSuggestedPaths: string[] | undefined;
        let aggregatedBranch = branch;
        let latestDebugPath: string | null = null;

        const limitedRun = typeof normalizedLimit === "number";
        let remaining = limitedRun ? normalizedLimit ?? 0 : 0;
        let currentPage = 1;

        while (true) {
          const batchSize = limitedRun
            ? Math.min(ISSUE_BATCH_SIZE, Math.max(remaining, 0))
            : ISSUE_BATCH_SIZE;

          if (limitedRun && batchSize <= 0) {
            break;
          }

          const response = await fetch("/api/estimate", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            credentials: "include",
            body: JSON.stringify({
              ...baseRequestBody,
              issuePage: currentPage,
              issueLimit: batchSize,
            }),
          });

          if (!response.ok) {
            const payload = await response.json().catch(() => null);
            throw new Error(payload?.error ?? "Unable to generate estimates");
          }

          const payload = (await response.json()) as EstimateResponse;
          const batchEstimates = payload.estimates ?? [];
          aggregatedEstimates.push(...batchEstimates);

          if (Array.isArray(payload.selectedFiles) && payload.selectedFiles.length) {
            aggregatedSelectedFiles = payload.selectedFiles;
          }

          if (Array.isArray(payload.repoTree) && payload.repoTree.length) {
            aggregatedRepoTree = payload.repoTree;
            if (Array.isArray(payload.suggestedPaths)) {
              aggregatedSuggestedPaths = payload.suggestedPaths;
            }
          } else if (Array.isArray(payload.suggestedPaths) && payload.suggestedPaths.length) {
            aggregatedSuggestedPaths = payload.suggestedPaths;
          }

          if (payload.branch) {
            aggregatedBranch = payload.branch;
          }

          if (payload.debugCapturePath) {
            latestDebugPath = payload.debugCapturePath;
          }

          const hasMoreFlag = payload.hasMore ?? (batchEstimates.length >= batchSize);

          if (limitedRun) {
            remaining = Math.max(remaining - batchEstimates.length, 0);
          }

          if (batchEstimates.length === 0 && hasMoreFlag) {
            currentPage += 1;
            continue;
          }

          if (!hasMoreFlag || (limitedRun && remaining <= 0)) {
            break;
          }

          currentPage += 1;
        }

        setEstimates(aggregatedEstimates);
        setSelectedFilesMeta(aggregatedSelectedFiles ?? []);
        if (aggregatedRepoTree && aggregatedRepoTree.length > 0) {
          setRepoTree(aggregatedRepoTree);
          if (Array.isArray(aggregatedSuggestedPaths)) {
            setSuggestedPaths(aggregatedSuggestedPaths);
          }
        } else if (Array.isArray(aggregatedSuggestedPaths)) {
          setSuggestedPaths(aggregatedSuggestedPaths);
        }
        if (aggregatedBranch) {
          setBranch(aggregatedBranch);
        }
        setDebugCapturePath(latestDebugPath);

        if (cacheKey) {
          setCache((prev) => ({
            ...prev,
            [cacheKey]: {
              estimates: aggregatedEstimates,
              savedAt: Date.now(),
              limit: normalizedLimit ?? null,
              selectedPaths: effectiveSelection,
              branch: aggregatedBranch ?? branch,
              selectedFiles: aggregatedSelectedFiles,
              ...(openRouterModel ? { model: openRouterModel } : {}),
            },
          }));
        }

        setNotice(
          `Estimates updated${selectionTrimmed ? " (first 25 selections applied)" : ""}.`
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unexpected error while estimating issues");
      } finally {
        setActiveProgressId(null);
        setProgressSnapshot(null);
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
      openRouterModel,
      selectionTrimmed,
      trimmedRepo,
      debugCaptureEnabled,
    ]
  );

  const handleEstimateSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!includeAllIssues && normalizedLimit === undefined) {
        setError("Enter a valid number of open issues to analyze.");
        setNotice(null);
        return;
      }
      await runEstimation();
    },
    [includeAllIssues, normalizedLimit, runEstimation, setError, setNotice]
  );

  const handleRefresh = useCallback(async () => {
    await runEstimation({ bypassCache: true });
  }, [runEstimation]);

  const handleDebugCaptureChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setDebugCaptureEnabled(event.target.checked);
    },
    []
  );

  const handleCopyDebugPath = useCallback(async () => {
    const scheduleReset = () => {
      if (debugCopyTimeoutRef.current !== null) {
        window.clearTimeout(debugCopyTimeoutRef.current);
      }
      debugCopyTimeoutRef.current = window.setTimeout(() => {
        setDebugCopyState("idle");
        debugCopyTimeoutRef.current = null;
      }, 2000);
    };

    if (!debugCapturePath || typeof navigator === "undefined" || !navigator.clipboard) {
      setDebugCopyState("error");
      scheduleReset();
      return;
    }

    try {
      await navigator.clipboard.writeText(debugCapturePath);
      setDebugCopyState("copied");
    } catch {
      setDebugCopyState("error");
    }

    scheduleReset();
  }, [debugCapturePath]);

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

  const issueCountDescription = includeAllIssues
    ? "All open issues"
    : normalizedLimit
    ? `${normalizedLimit} issue${normalizedLimit === 1 ? "" : "s"}`
    : "Limited open issues";

  if (!authChecked) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50">
        <span className="text-sm text-slate-500">Checking access…</span>
      </main>
    );
  }

  if (!authorized) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50 p-4">
        <form
          onSubmit={handlePasswordSubmit}
          className="w-full max-w-sm space-y-4 rounded-lg border border-slate-200 bg-white p-6 shadow-sm"
        >
          <div className="space-y-2 text-center">
            <h1 className="text-xl font-semibold text-slate-800">Enter Access Password</h1>
            <p className="text-sm text-slate-500">
              This app is protected. Provide the access password to continue.
            </p>
          </div>

          <div className="space-y-2 text-left">
            <label className="text-sm font-medium text-slate-700" htmlFor="accessPassword">
              Password
            </label>
            <Input
              id="accessPassword"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={authPassword}
              onChange={handlePasswordChange}
              disabled={authLoading}
              required
            />
          </div>

          {authError ? (
            <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-600">
              {authError}
            </p>
          ) : null}

          <Button type="submit" className="w-full" disabled={authLoading}>
            {authLoading ? "Verifying…" : "Unlock app"}
          </Button>
        </form>
      </main>
    );
  }

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

          <p className="text-xs text-slate-500">
            Need higher GitHub rate limits? Add your token in the Settings page first.
          </p>

          <Button type="submit" disabled={isLoadingRepo} className="w-full sm:w-auto">
            {isLoadingRepo ? "Loading repository…" : "Load repository"}
          </Button>
        </form>
        {branch ? (
          <p className="text-xs text-slate-500">Using branch: {branch}</p>
        ) : null}
      </section>

      {loadingAction === "load-repo" ? progressCard : null}

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
            <div className="space-y-3">
              <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
                <input
                  id="includeAllIssues"
                  type="checkbox"
                  className="h-4 w-4"
                  checked={includeAllIssues}
                  disabled={isEstimating}
                  onChange={handleIncludeAllToggle}
                />
                <span>Fetch all open issues</span>
              </label>
              {includeAllIssues ? (
                <p className="text-xs text-slate-500">
                  Issues are pulled newest-first. Uncheck to limit how many are fetched.
                </p>
              ) : (
                <div className="space-y-2">
                  <label className="text-sm font-medium text-slate-700" htmlFor="issueLimit">
                    How many open issues?
                  </label>
                  <Input
                    id="issueLimit"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    placeholder="e.g. 10"
                    value={issueLimit}
                    disabled={isEstimating}
                    onChange={(event) => setIssueLimit(event.target.value)}
                    required
                  />
                  <p className="text-xs text-slate-500">
                    Issues are pulled newest-first. Increase the number for a broader sweep.
                  </p>
                </div>
              )}
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-wrap items-center gap-2">
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
              <label className="flex items-center gap-2 text-sm text-slate-600">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={debugCaptureEnabled}
                  disabled={isEstimating}
                  onChange={handleDebugCaptureChange}
                />
                <span className="font-medium text-slate-700">Debug capture</span>
                <span className={debugCaptureEnabled ? "text-emerald-600" : "text-slate-500"}>
                  {debugCaptureEnabled ? "On" : "Off"}
                </span>
              </label>
            </div>
          </form>
          {debugCaptureEnabled ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <span>Debug capture is enabled.</span>
              {debugCapturePath ? (
                <>
                  <span>Latest session:</span>
                  <code className="rounded bg-slate-100 px-1 py-0.5 text-[11px] text-slate-600">
                    {debugCapturePath}
                  </code>
                  <button
                    type="button"
                    className="font-medium text-slate-600 underline-offset-4 hover:underline"
                    onClick={handleCopyDebugPath}
                  >
                    Copy path
                  </button>
                  {debugCopyState === "copied" ? (
                    <span className="text-emerald-600">Copied!</span>
                  ) : null}
                  {debugCopyState === "error" ? (
                    <span className="text-rose-500">Unable to copy</span>
                  ) : null}
                </>
              ) : (
                <span>Run an estimate to capture the current prompts.</span>
              )}
            </div>
          ) : null}
        </section>
      ) : null}

      {loadingAction === "estimate" ? progressCard : null}

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
            <div className="flex flex-wrap items-center gap-3">
              <a
                href={csvHref}
                download="issue-estimates.csv"
                className="inline-flex items-center justify-center rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Download CSV
              </a>
            </div>
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
                  <th className="px-3 py-2 font-medium text-slate-500">Link</th>
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
