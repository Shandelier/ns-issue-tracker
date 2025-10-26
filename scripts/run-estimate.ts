import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvConfig } from "@next/env";
import { POST } from "../src/app/api/estimate/route";

async function main() {
  const projectDir = resolve(fileURLToPath(new URL("../", import.meta.url)));
  loadEnvConfig(projectDir);

  const [, , repoArg, limitArg] = process.argv;
  if (!repoArg) {
    console.error("Usage: npm run estimate -- <github-repo-url> [issueLimit]");
    process.exit(1);
  }

  const issueLimit = limitArg ? Number.parseInt(limitArg, 10) : undefined;
  if (issueLimit !== undefined && (!Number.isFinite(issueLimit) || issueLimit <= 0)) {
    console.error("Issue limit must be a positive number");
    process.exit(1);
  }

  const body = {
    repoUrl: repoArg,
    issueLimit,
  };

  const request = new Request("https://local.test/api/estimate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const response = await POST(request);
  const json = await response.json();

  if (!response.ok) {
    console.error("Request failed", json);
    process.exit(1);
  }

  const estimates: Array<{
    issue_number: number;
    title: string;
    complexity: string;
    estimated_cost: string;
    labels: string;
    url: string;
  }> = json.estimates ?? [];

  if (!estimates.length) {
    console.log("No open issues found.");
    return;
  }

  const header = "issue_number,title,complexity,estimated_cost,labels,url";
  const rows = estimates.map((estimate) =>
    [
      estimate.issue_number,
      `"${estimate.title.replace(/"/g, '""')}"`,
      estimate.complexity,
      estimate.estimated_cost,
      `"${(estimate.labels ?? "").replace(/"/g, '""')}"`,
      estimate.url,
    ].join(",")
  );
  const csv = [header, ...rows].join("\n");

  const outPath = resolve(fileURLToPath(new URL("../", import.meta.url)), "estimates.csv");
  writeFileSync(outPath, csv, "utf8");

  console.log(csv);
  console.log(`\nSaved to ${outPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
