# Integrations: every signal, every tool, and how it is reached

Generated from `packages/core/src/signals.ts` by `npm run docs:signals`. Paths are tried in order: **dynatrace** (one DQL query when Dynatrace already collects the signal), **mcp** (the tool's official MCP server), **rest** (its API), **custom** (wrap any other tool once as an MCP server with `templates/custom-mcp-server`).

## What "built" means, and what is not verified

- **Built and tested:** paths not marked "listed" are called by the app, and their signals have dummy data in the tool's real format that the agent or the engines consume. CI runs the agent over all 12 failure types with these signals.
- **Listed:** a documented route the app does not call yet (useful to Cursor agents through the same MCP servers, or a later phase).
- **Not verified against live systems:** no path has run against a real tenant yet. DQL field names depend on your Dynatrace configuration (OpenPipeline, Operator version). MCP tool names are the candidates each server publishes; confirm with `GET /api/mcp/tools` and override under `toolMap` in `mcp.servers.json` (the first match is used).
- **Licences:** ServiceNow's MCP Server Console and Now Assist need a Now Assist licence; the Copilot hand-off needs a paid Copilot plan with the coding agent enabled and `AGENT_WRITE_ALLOWLIST=<github server>:create_issue`; Dynatrace Intelligence agents depend on your Dynatrace contract.

## Dynatrace (hub)

| Signal | Fields | Paths, in order | Used by | Status |
| --- | --- | --- | --- | --- |
| Problems (Davis) | display_id, event.name, status, category, start, end, root cause, affected entities | 1. **dynatrace** fetch dt.davis.problems<br>2. **mcp** dynatrace-mcp (`execute_dql`) | collector: dynatrace; agent: dt_problem | Built |
| SDLC deployment events | deployment status, environment, commit, version, product, change request | 1. **dynatrace** fetch events | filter event.kind == "SDLC_EVENT"<br>2. **mcp** dynatrace-mcp (`execute_dql`) | collector: dynatrace; agent: dt_deployment_events | Built |
| Service metrics (requests, failures, p95, DB calls) | request count, failure count, p95 response time, DB calls per request | 1. **dynatrace** timeseries dt.service.request.*<br>2. **mcp** dynatrace-mcp (`execute_dql`) | collector: dynatrace; agent: dt_error_rate, dt_latency | Built |
| Logs | timestamp, loglevel, content, service, k8s namespace, pod, container | 1. **dynatrace** fetch logs | filter loglevel == "ERROR"<br>2. **mcp** dynatrace-mcp (`execute_dql`) | agent: dt_logs | Built |
| Traces and spans | trace id, span name, duration, status code, service, DB statement | 1. **dynatrace** fetch spans<br>2. **mcp** dynatrace-mcp (`execute_dql`) | agent: dt_traces | Built |
| Kubernetes pods, containers and nodes (Dynatrace Operator) | cluster, namespace, workload, pod, container, node, restarts, termination reason, memory vs limit, node conditions | 1. **dynatrace** timeseries dt.kubernetes.container.* by pod, container, node<br>2. **mcp** kubernetes / EKS / AKS / GKE MCP servers (`pods_list`, `list_k8s_resources`, `get_k8s_resources`) | agent: k8s_workload | Built |
| Workload CPU and memory vs requests | requests, limits, p95 usage per workload | 1. **dynatrace** timeseries dt.kubernetes.container.cpu_usage, memory_working_set<br>2. **mcp** dynatrace-mcp (`execute_dql`) | collector: dynatrace (rightsizing) | Built |
| Vulnerabilities (Runtime Vulnerability Analytics) | CVE, component, risk level, affected service, exposure | 1. **dynatrace** fetch security.events<br>2. **mcp** github-mcp (fallback) (`list_code_scanning_alerts`, `list_dependabot_alerts`) | agent: security_findings | Built |
| DORA metrics | deployment frequency, lead time, change failure rate, MTTR | 1. **dynatrace** DORA notebook query / SDLC events<br>2. **mcp** dynatrace-mcp (`execute_dql`) | collector: dynatrace (reconciliation) | Built |
| Dynatrace usage cost | capability, product, cost | 1. **dynatrace** fetch dt.system.events (billing) | collector: dynatrace (cost) | Built |
| Dynatrace Intelligence / Davis assessment _(vendor-agent)_ | Dynatrace's own root-cause explanation for the problem | 1. **mcp** dynatrace-mcp (tool names vary by version) (`chat_with_davis_copilot`, `davis_copilot_chat`, `explain_problem`) | agent: vendor_assessment | Built, opt-in |

## Kubernetes (EKS, AKS, GKE, any cluster)

| Signal | Fields | Paths, in order | Used by | Status |
| --- | --- | --- | --- | --- |
| Warning events | reason (CrashLoopBackOff, OOMKilled, ImagePullBackOff), message, involved object, time | 1. **dynatrace** fetch events | filter k8s.namespace.name _(listed, not called by the app yet)_<br>2. **mcp** kubernetes MCP (`events_list`, `list_events`)<br>3. **rest** core/v1 events API | collector: kubernetes; agent: k8s_events | Built |
| Pods, containers, nodes (state) | phase, ready, restartCount, lastState.terminated.reason, node, resource limits | 1. **dynatrace** see dt-k8s<br>2. **mcp** kubernetes / EKS / AKS / GKE MCP servers (`pods_list`, `list_k8s_resources`)<br>3. **rest** core/v1 pods and nodes API _(listed, not called by the app yet)_ | agent: k8s_workload | Built |

## AWS

| Signal | Fields | Paths, in order | Used by | Status |
| --- | --- | --- | --- | --- |
| Cost by product tag | service, usage type, environment, amount, commitment coverage | 1. **rest** Cost Explorer GetCostAndUsage via AWS CLI credential chain<br>2. **mcp** AWS MCP servers (cost) (`get_cost_and_usage`) _(listed, not called by the app yet)_ | collector: aws | Built |
| CloudTrail: who changed what | EventName, EventTime, Username, EventSource, Resources | 1. **mcp** AWS MCP servers (CloudTrail, or the AWS API server) (`lookup_events`, `lookup_cloudtrail_events`, `call_aws`)<br>2. **dynatrace** fetch logs | filter log.source == "aws.cloudtrail" (if forwarded) _(listed, not called by the app yet)_ | agent: cloud_changes | Built |
| CloudWatch metrics and alarms | alarms, metrics for managed services (RDS, SQS, ALB) | 1. **dynatrace** Dynatrace AWS integration: cloud.aws.* metrics _(listed, not called by the app yet)_<br>2. **mcp** AWS MCP servers (CloudWatch) (`get_metric_data`, `describe_alarms`) _(listed, not called by the app yet)_ | not used yet: next candidate evidence for managed-service failures (RDS, SQS, ALB) | Catalogued, not consumed yet |
| EKS clusters and node groups | cluster version, node group scaling, instance types | 1. **dynatrace** Dynatrace Operator on EKS<br>2. **mcp** Amazon EKS MCP server (`list_k8s_resources`) | agent: k8s_workload | Built |

## Azure

| Signal | Fields | Paths, in order | Used by | Status |
| --- | --- | --- | --- | --- |
| Cost by product tag | service, tag, environment, pre-tax cost | 1. **rest** Cost Management query API<br>2. **mcp** Azure MCP server (`cost_query`) _(listed, not called by the app yet)_ | collector: azure | Built |
| Activity Log: who changed what | operationName, caller, status, resourceId, eventTimestamp | 1. **mcp** Azure MCP server / AKS MCP server (`monitor_activitylog_list`, `az_monitor_activity_log`, `call_az`)<br>2. **dynatrace** fetch logs | filter azure.resource.id (if forwarded) _(listed, not called by the app yet)_ | agent: cloud_changes | Built |
| Azure Monitor and AKS | AKS node and pod state, Monitor metrics | 1. **dynatrace** Dynatrace Azure integration and Operator on AKS<br>2. **mcp** AKS MCP server (preview) (`list_k8s_resources`) | agent: k8s_workload | Built |

## Google Cloud

| Signal | Fields | Paths, in order | Used by | Status |
| --- | --- | --- | --- | --- |
| Cost by product label (Billing export) | service, sku, usage_start_time, labels, cost | 1. **rest** BigQuery jobs.query on the billing export<br>2. **mcp** Google Cloud BigQuery MCP server (`execute_sql`, `query`) _(listed, not called by the app yet)_ | collector: gcp | Built |
| Cloud Audit Logs: who changed what | protoPayload.methodName, authenticationInfo.principalEmail, resourceName, timestamp | 1. **mcp** Google Cloud Logging MCP server (`list_log_entries`, `query_logs`)<br>2. **dynatrace** fetch logs | filter gcp.resource.type (if forwarded) _(listed, not called by the app yet)_ | agent: cloud_changes | Built |
| GKE, Cloud Monitoring, Cloud Trace | GKE workload state, metrics, traces | 1. **dynatrace** Dynatrace Google Cloud integration and Operator on GKE<br>2. **mcp** Google Cloud GKE MCP server (`list_k8s_resources`) | agent: k8s_workload | Built |

## GitHub

| Signal | Fields | Paths, in order | Used by | Status |
| --- | --- | --- | --- | --- |
| PRs, commits, CI jobs, failure annotations, repo files | pulls, jobs, check-run annotations, contents | 1. **rest** REST v2022-11-28<br>2. **mcp** github-mcp (`get_pull_request_files`, `get_job_logs`) | collector: github; agent: gh_pr_files, gh_job_log | Built |
| Code scanning and Dependabot alerts | rule, severity, state, file, CVE | 1. **mcp** github-mcp (`list_code_scanning_alerts`, `list_dependabot_alerts`)<br>2. **rest** code-scanning/alerts, dependabot/alerts _(listed, not called by the app yet)_ | agent: security_findings | Built |
| Copilot coding agent: fix after approval _(action)_ | issue created from the approved recommendation, assigned to Copilot, which opens a draft PR | 1. **mcp** github-mcp (write, allowlist required) (`create_issue`, `assign_copilot_to_issue`) | agent: after approval | Built, opt-in |

## Argo CD

| Signal | Fields | Paths, in order | Used by | Status |
| --- | --- | --- | --- | --- |
| Applications: sync and health | sync status, health, operation phase and message | 1. **dynatrace** SDLC events from Argo CD notifications _(listed, not called by the app yet)_<br>2. **mcp** argocd-mcp (argoproj-labs) (`get_application`, `list_applications`)<br>3. **rest** /api/v1/applications | collector: argocd; agent: argo_app | Built |

## ServiceNow

| Signal | Fields | Paths, in order | Used by | Status |
| --- | --- | --- | --- | --- |
| CMDB business applications and change requests | business app, owner, criticality, repos, services, namespaces, cost tag; change state, risk, approval | 1. **rest** Table API<br>2. **mcp** ServiceNow MCP Server Console (Zurich+, Now Assist) (`table_query`) _(listed, not called by the app yet)_ | collector: servicenow | Built |
| Incidents, problems, knowledge articles | incident number, description, close notes; kb_knowledge text | 1. **rest** Table API incident, problem, kb_knowledge _(listed, not called by the app yet)_<br>2. **mcp** ServiceNow MCP Server Console (`table_query`, `search_knowledge`) _(listed, not called by the app yet)_ | agent: kb_similar (knowledge base built from dummy ServiceNow-shaped records until this is connected) | Catalogued, not consumed yet |
| Now Assist incident agent: similar incidents and resolution _(vendor-agent)_ | ServiceNow's own similar-incident search and proposed resolution | 1. **mcp** ServiceNow MCP Server Console exposing Now Assist skills (`now_assist_similar_incidents`, `incident_resolution_recommendation`) | agent: vendor_assessment | Built, opt-in |

## Any other tool

| Signal | Fields | Paths, in order | Used by | Status |
| --- | --- | --- | --- | --- |
| Any other or in-house tool | the tool's own records, in its own schema | 1. **custom** Wrap it once as an MCP server (templates/custom-mcp-server), list it in mcp.servers.json, map its tool in toolMap | agent and collector, through the same tool map | Pattern + template |
