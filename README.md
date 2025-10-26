# Issue Estimator

Minimal tool that scans a GitHub repository, sends open issues (defaults to the first five) to GPT-5 once, and produces a CSV with complexity and cost estimates.

## Getting started

```bash
npm install
npm run dev
```

Create an `.env.local` file with the following variables before starting the dev server:

add this to shell for easier use
```bash
OPENROUTER_API_KEY=sk-...
GITHUB_TOKEN=ghp_...
APP_PASSWORD_SHA256=bdc398057a16edaab67ee1f361f9d59cc7f58c442364b1311590da49fb6fd2a9
```

`APP_PASSWORD_SHA256` stores the SHA-256 digest of the access password; replace it with your own digest if you change the password.

The GitHub token is optional but recommended to avoid rate limits. Never commit this file.

## Usage

usually hosted on localhost:3000
provide password and github url, for example:
https://github.com/AykutSarac/jsoncrack.com

## Tech stack

- [Next.js 14](https://nextjs.org/) with the App Router
- Minimal [shadcn/ui](https://ui.shadcn.com/) primitives (Button, Input)
- Tailwind CSS for layout
- GitHub REST API + OpenRouter
