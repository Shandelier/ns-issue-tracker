"use client";

import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  DEFAULT_SETTINGS,
  OPENROUTER_MODEL_OPTIONS,
  type IssueEstimatorSettings,
  loadSettingsFromStorage,
  saveSettingsToStorage,
} from "@/lib/settings";

type SaveStatus = "idle" | "saving" | "saved" | "error";

export default function SettingsPage() {
  const [formState, setFormState] = useState<IssueEstimatorSettings>({
    ...DEFAULT_SETTINGS,
  });
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");

  useEffect(() => {
    const stored = loadSettingsFromStorage();
    if (stored) {
      setFormState(stored);
    }
  }, []);

  useEffect(() => {
    if (saveStatus !== "saved") {
      return;
    }

    const timeout = window.setTimeout(() => {
      setSaveStatus("idle");
    }, 2200);

    return () => window.clearTimeout(timeout);
  }, [saveStatus]);

  const handleChange =
    (field: keyof IssueEstimatorSettings) =>
    (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      const value = event.target.value;
      setFormState((prev) => ({
        ...prev,
        [field]: value,
      }));
      setSaveStatus("idle");
    };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaveStatus("saving");
    const success = saveSettingsToStorage(formState);
    setSaveStatus(success ? "saved" : "error");
  };

  const saveMessage = useMemo(() => {
    if (saveStatus === "saving") {
      return "Saving…";
    }
    if (saveStatus === "saved") {
      return "Settings saved to this browser.";
    }
    if (saveStatus === "error") {
      return "Could not save settings. Check your browser storage permissions.";
    }
    return null;
  }, [saveStatus]);

  return (
    <main className="container max-w-2xl space-y-8 py-12">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-slate-600">
          Store credentials and preferences locally so you can reuse them while estimating issues.
        </p>
      </header>

      <section className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <form className="space-y-6" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700" htmlFor="openRouterKey">
              OpenRouter API key
            </label>
            <Input
              id="openRouterKey"
              type="password"
              placeholder="sk-or-..."
              value={formState.openRouterKey}
              onChange={handleChange("openRouterKey")}
              autoComplete="off"
            />
            <p className="text-xs text-slate-500">
              Stored in your browser only. Needed to call OpenRouter models during estimation.
            </p>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700" htmlFor="githubToken">
              GitHub token
            </label>
            <Input
              id="githubToken"
              type="password"
              placeholder="ghp_..."
              value={formState.githubToken}
              onChange={handleChange("githubToken")}
              autoComplete="off"
            />
            <p className="text-xs text-slate-500">
              Optional but recommended to avoid low anonymous API rate limits.
            </p>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700" htmlFor="openRouterModel">
              OpenRouter model
            </label>
            <Select
              id="openRouterModel"
              value={formState.model}
              onChange={handleChange("model")}
            >
              {OPENROUTER_MODEL_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
            <p className="text-xs text-slate-500">
              Used for future cost estimates. You can swap models without losing other settings.
            </p>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700" htmlFor="hourlyRate">
              Hourly cost per programmer
            </label>
            <Input
              id="hourlyRate"
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              placeholder="80.00"
              value={formState.hourlyRate}
              onChange={handleChange("hourlyRate")}
            />
            <p className="text-xs text-slate-500">
              Not applied yet, but we&apos;ll use it soon to translate complexity into cost.
            </p>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <Button type="submit" disabled={saveStatus === "saving"}>
              {saveStatus === "saving" ? "Saving…" : "Save settings"}
            </Button>
            {saveMessage ? (
              <p
                className={`text-xs ${
                  saveStatus === "error" ? "text-amber-600" : "text-slate-500"
                }`}
              >
                {saveMessage}
              </p>
            ) : null}
          </div>
        </form>
      </section>
    </main>
  );
}
