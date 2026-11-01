# Collector agents (Cursor)

Run each prompt as a Cursor agent with the MCP servers in `.cursor/mcp.json`. Each agent pulls one source through MCP, writes the payload in that source's native schema, and pushes it to the app. Run them on a schedule (Cursor background agent or CI) or by hand before a review.

Shared instructions for every collector:

> Read-only. Do not modify anything in the source system. Write the result to `data/inbox/<source>.json` and POST the same JSON to `http://localhost:8787/api/ingest/<source>`. The shape must match `fixtures/raw/<source>.json` field for field. If the POST returns 422, compare your payload against the fixture and fix the payload. Report the record counts you pushed.

---

## 1. ServiceNow: product identity and changes
Using the ServiceNow MCP server:
1. Query `cmdb_ci_business_app` with `operational_status=1`, `sysparm_display_value=all`, fields: `sys_id, number, name, owned_by, support_group, business_criticality, u_repositories, u_dynatrace_services, u_k8s_namespaces, u_cost_tag, u_downtime_cost_per_min`.
2. Flatten every field to its `value`, except `owned_by`, `support_group` and `cmdb_ci`, which keep `{value, display_value}`.
3. Query `change_request` where `cmdb_ci` is one of those sys_ids and `opened_at` is within the last 30 days, same flattening, fields: `sys_id, number, state, risk, type, approval, opened_at, approval_set, start_date, end_date, closed_at, close_code, cmdb_ci, correlation_id`.
4. Payload: `{ "businessApps": [...], "changes": [...] }`.

## 2. GitHub: merges, jobs, failures, code
Using the GitHub MCP server, for every repo listed in the ServiceNow `u_repositories` fields:
1. Pull requests merged in the last 30 days (full PR object, including `additions`, `deletions`, `changed_files`). Commits per PR.
2. Workflow runs in the window, their jobs, and for each failed job the check-run annotations.
3. Repository contents for: Dockerfile, dependency manifests, `.github/workflows/*`, `.github/dependabot.yml`, CODEOWNERS, k8s/helm manifests, `*.tf`, and source files under `src|app|internal|cmd|lib` (max 150 files). Keep `content` base64 as the contents API returns it.
4. Payload: `{ "pulls": [...], "prCommits": {"org/repo#123": [...]}, "jobs": [...], "annotations": {"<jobId>": [...]}, "contents": {"org/repo": [...]} }`.

## 3. Dynatrace: problems, SDLC events, metrics, DORA, billing
Using the Dynatrace MCP server `execute_dql` tool, run each query in `DQL` from `packages/core/src/sources.ts` and keep each full response:
`{ "problems": <response>, "sdlcEvents": <response>, "serviceMetrics": <response>, "workloads": <response>, "dora": <response>, "billing": <response> }`.
Each response keeps `{ state, result: { records } }`. Before running, check the estimated bytes scanned and narrow the window if a query exceeds your Grail budget.

## 4. Argo CD
`list_applications` (read-only). Payload: `{ "applications": [ ...Application objects... ] }`.

## 5. Kubernetes
Warning events across the product namespaces from the CMDB. Payload: `{ "events": [ ...core/v1 Event... ] }`.

## 6. AWS cost
Cost Explorer `GetCostAndUsage`, monthly, last 6 months, metric `UnblendedCost`. For each environment tag value (prod, staging, dev): one call grouped by `SERVICE` + `TAG:product`, one grouped by `USAGE_TYPE` + `TAG:product`. Savings Plans coverage grouped by `SERVICE`.
Payload: `{ "costExplorer": [{ "environment": "prod", "byService": <response>, "byUsageType": <response> }, ...], "commitmentCoverage": { "*|<SERVICE>|<env>": 0.35 } }`.

## 7. Azure cost
Cost Management Query, `ActualCost`, monthly, grouped by `ServiceName` and tag `product`. Payload: `{ "costManagement": <response> }`.
