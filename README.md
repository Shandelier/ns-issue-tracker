# Issue Estimator

Minimal tool that scans a GitHub repository, sends open issues (defaults to the first five) to GPT-5 once, and produces a CSV with complexity and cost estimates.

## Hosted app

https://issue-estimator-demo.vercel.app

> Configure the deployment with your `OPENAI_API_KEY` (GPT-5 access) and optional `GITHUB_TOKEN`.

## Getting started

```bash
npm install
npm run dev
```

Create an `.env.local` file with the following variables before starting the dev server:

```bash
OPENAI_API_KEY=sk-...
GITHUB_TOKEN=ghp_...
```

The GitHub token is optional but recommended to avoid rate limits. Never commit this file.

### Command line run

You can trigger the estimator once from the terminal without launching the UI. The script automatically loads environment
variables from `.env.local`/`.env` just like Next.js, so you can keep the same secrets for both the UI and CLI flows:

```bash
npm run estimate -- https://github.com/org/project 5
```

The command prints the CSV to stdout and stores it at `./estimates.csv`. Omit the trailing `5` to use the default limit.

## Usage

1. Open the web UI.
2. Paste any GitHub repository URL (e.g. `https://github.com/org/project`).
3. Adjust the **Issue limit** field if you want more than the default five issues, or clear it to process the full backlog.
4. Optionally add a GitHub token for higher rate limits.
5. Click **Generate CSV**. The app fetches the requested issues, requests a single GPT-5 estimation, and shows a preview.
6. Re-running the same repository and limit reuses the cached estimates stored in your browser; use **Refresh from GitHub** to force a new run.
7. Download the CSV (`issue_number,title,complexity,estimated_cost,labels,url`).

> The estimator requires a valid `OPENAI_API_KEY` with GPT-5 access. The run fails fast if the model cannot be reached so you always see the genuine output from the model.

### Sample output

Run the CLI with a configured key to generate the CSV for [`mindcraft-bots/mindcraft`](https://github.com/mindcraft-bots/mindcraft) or any other repository. The generated file is not committed—rerun the command whenever you need a fresh estimate.

### Offline preview

If you only need a quick look at the interface without installing dependencies, open [`public/preview.html`](public/preview.html) in any browser. It renders a static version of the form and table that mirrors the live app and is useful for documentation screenshots.

## Tech stack

- [Next.js 14](https://nextjs.org/) with the App Router
- Minimal [shadcn/ui](https://ui.shadcn.com/) primitives (Button, Input)
- Tailwind CSS for layout
- GitHub REST API + OpenAI GPT-5 (`gpt-5.0-mini` model)
