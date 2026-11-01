# Analysis agents (Cursor)

These agents work on top of the app's deterministic output. They read the API, then go deeper through MCP. They never write back to Dynatrace, GitHub or ServiceNow without a human approving the change.

## Investigate a failure (MTTR)
> Fetch `GET /api/failures?product=<id>` and pick the finding I name (or the newest critical one).
> Fetch `POST /api/ai/brief {"mode":"finding","target":"<finding id>"}` for the ranked actions.
> Then confirm the root cause chain through MCP, cheapest evidence first:
> 1. Dynatrace: the problem record and its root cause entity; DQL for the service's error rate and p95 one hour before and after the deployment finished.
> 2. Argo CD: the application's operation state and sync result for that revision.
> 3. GitHub: the PR diff for the deployed SHA, focusing on files the evidence names.
> Report: the confirmed cause in one sentence, the evidence per source, the restore step, and the prevention control with its rule id. If the evidence contradicts the rule's classification, say so and propose a new rule for `FAILURE_RULES`.

## Review a product's codebase (phase 4)
> Fetch `GET /api/code?product=<id>` and `GET /api/scorecards?product=<id>`.
> For each high or critical finding, open the file through the GitHub MCP server and confirm it. Drop false positives with a one-line reason.
> For `ARCH-CACHE-ASIDE`, pull the top repeated DB statements for the service from Dynatrace spans, pick the endpoints a cache would serve, propose the key design and TTL, and check whether an ElastiCache cluster already exists for the product before proposing a new one.
> Output a pull request plan: one PR per finding, smallest risk first, each with the official reference from the finding.

## Leadership brief
> Fetch `POST /api/ai/brief {"mode":"portfolio","target":"all"}` and `GET /api/cost`.
> Produce five bullets: the product that needs intervention first and why, the top failure pattern across products, the largest saving with its effort, the DORA band most at risk, and one decision you need from leadership.
