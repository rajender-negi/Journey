// Signal catalogue: every signal the app can use, from every tool, with the ways to reach it in the
// order they are tried. The rule: do not build a connection that already exists.
//   1. dynatrace  the signal is already in Dynatrace (Operator, cloud integrations, OpenPipeline): one DQL query
//   2. mcp        the tool's official MCP server
//   3. rest       the tool's API or SDK
//   4. custom     wrap anything else (in-house tools) as an MCP server once: templates/custom-mcp-server
// Vendor agents are sources too: their assessment is asked for and cited like any other evidence.

export type SignalPath =
  | { via: 'dynatrace'; how: string; listed?: true }
  | { via: 'mcp'; how: string; tools: string[]; listed?: true }
  | { via: 'rest'; how: string; listed?: true }
  | { via: 'custom'; how: string; listed?: true }
// listed: a documented route (for Cursor agents or a later phase) that the app does not call yet

export interface SignalSpec {
  id: string
  tool: 'dynatrace' | 'kubernetes' | 'aws' | 'azure' | 'gcp' | 'github' | 'argocd' | 'servicenow' | 'any'
  name: string
  kind: 'signal' | 'vendor-agent' | 'action'
  fields: string
  paths: SignalPath[]
  usedBy: string[]
  status: 'built' | 'built-optional' | 'pattern' | 'catalogued'
}

const DT = (how: string): SignalPath => ({ via: 'dynatrace', how })
const MCP = (how: string, ...tools: string[]): SignalPath => ({ via: 'mcp', how, tools })
const REST = (how: string): SignalPath => ({ via: 'rest', how })
const LISTED = (p: SignalPath): SignalPath => ({ ...p, listed: true })

export const SIGNALS: SignalSpec[] = [
  // ---------- Dynatrace (the hub) ----------
  { id: 'dt-problems', tool: 'dynatrace', name: 'Problems (Davis)', kind: 'signal', fields: 'display_id, event.name, status, category, start, end, root cause, affected entities', paths: [DT('fetch dt.davis.problems'), MCP('dynatrace-mcp', 'execute_dql')], usedBy: ['collector: dynatrace', 'agent: dt_problem'], status: 'built' },
  { id: 'dt-sdlc', tool: 'dynatrace', name: 'SDLC deployment events', kind: 'signal', fields: 'deployment status, environment, commit, version, product, change request', paths: [DT('fetch events | filter event.kind == "SDLC_EVENT"'), MCP('dynatrace-mcp', 'execute_dql')], usedBy: ['collector: dynatrace', 'agent: dt_deployment_events'], status: 'built' },
  { id: 'dt-metrics', tool: 'dynatrace', name: 'Service metrics (requests, failures, p95, DB calls)', kind: 'signal', fields: 'request count, failure count, p95 response time, DB calls per request', paths: [DT('timeseries dt.service.request.*'), MCP('dynatrace-mcp', 'execute_dql')], usedBy: ['collector: dynatrace', 'agent: dt_error_rate, dt_latency'], status: 'built' },
  { id: 'dt-logs', tool: 'dynatrace', name: 'Logs', kind: 'signal', fields: 'timestamp, loglevel, content, service, k8s namespace, pod, container', paths: [DT('fetch logs | filter loglevel == "ERROR"'), MCP('dynatrace-mcp', 'execute_dql')], usedBy: ['agent: dt_logs'], status: 'built' },
  { id: 'dt-traces', tool: 'dynatrace', name: 'Traces and spans', kind: 'signal', fields: 'trace id, span name, duration, status code, service, DB statement', paths: [DT('fetch spans'), MCP('dynatrace-mcp', 'execute_dql')], usedBy: ['agent: dt_traces'], status: 'built' },
  { id: 'dt-k8s', tool: 'dynatrace', name: 'Kubernetes pods, containers and nodes (Dynatrace Operator)', kind: 'signal', fields: 'cluster, namespace, workload, pod, container, node, restarts, termination reason, memory vs limit, node conditions', paths: [DT('timeseries dt.kubernetes.container.* by pod, container, node'), MCP('kubernetes / EKS / AKS / GKE MCP servers', 'pods_list', 'list_k8s_resources', 'get_k8s_resources')], usedBy: ['agent: k8s_workload'], status: 'built' },
  { id: 'dt-workloads', tool: 'dynatrace', name: 'Workload CPU and memory vs requests', kind: 'signal', fields: 'requests, limits, p95 usage per workload', paths: [DT('timeseries dt.kubernetes.container.cpu_usage, memory_working_set'), MCP('dynatrace-mcp', 'execute_dql')], usedBy: ['collector: dynatrace (rightsizing)'], status: 'built' },
  { id: 'dt-security', tool: 'dynatrace', name: 'Vulnerabilities (Runtime Vulnerability Analytics)', kind: 'signal', fields: 'CVE, component, risk level, affected service, exposure', paths: [DT('fetch security.events'), MCP('github-mcp (fallback)', 'list_code_scanning_alerts', 'list_dependabot_alerts')], usedBy: ['agent: security_findings'], status: 'built' },
  { id: 'dt-dora', tool: 'dynatrace', name: 'DORA metrics', kind: 'signal', fields: 'deployment frequency, lead time, change failure rate, MTTR', paths: [DT('DORA notebook query / SDLC events'), MCP('dynatrace-mcp', 'execute_dql')], usedBy: ['collector: dynatrace (reconciliation)'], status: 'built' },
  { id: 'dt-billing', tool: 'dynatrace', name: 'Dynatrace usage cost', kind: 'signal', fields: 'capability, product, cost', paths: [DT('fetch dt.system.events (billing)')], usedBy: ['collector: dynatrace (cost)'], status: 'built' },
  { id: 'dt-agent', tool: 'dynatrace', name: 'Dynatrace Intelligence / Davis assessment', kind: 'vendor-agent', fields: "Dynatrace's own root-cause explanation for the problem", paths: [MCP('dynatrace-mcp (tool names vary by version)', 'chat_with_davis_copilot', 'davis_copilot_chat', 'explain_problem')], usedBy: ['agent: vendor_assessment'], status: 'built-optional' },

  // ---------- Kubernetes (EKS, AKS, GKE, on-prem) ----------
  { id: 'k8s-events', tool: 'kubernetes', name: 'Warning events', kind: 'signal', fields: 'reason (CrashLoopBackOff, OOMKilled, ImagePullBackOff), message, involved object, time', paths: [LISTED(DT('fetch events | filter k8s.namespace.name')), MCP('kubernetes MCP', 'events_list', 'list_events'), REST('core/v1 events API')], usedBy: ['collector: kubernetes', 'agent: k8s_events'], status: 'built' },
  { id: 'k8s-workload', tool: 'kubernetes', name: 'Pods, containers, nodes (state)', kind: 'signal', fields: 'phase, ready, restartCount, lastState.terminated.reason, node, resource limits', paths: [DT('see dt-k8s'), MCP('kubernetes / EKS / AKS / GKE MCP servers', 'pods_list', 'list_k8s_resources'), LISTED(REST('core/v1 pods and nodes API'))], usedBy: ['agent: k8s_workload'], status: 'built' },

  // ---------- AWS ----------
  { id: 'aws-cost', tool: 'aws', name: 'Cost by product tag', kind: 'signal', fields: 'service, usage type, environment, amount, commitment coverage', paths: [REST('Cost Explorer GetCostAndUsage via AWS CLI credential chain'), LISTED(MCP('AWS MCP servers (cost)', 'get_cost_and_usage'))], usedBy: ['collector: aws'], status: 'built' },
  { id: 'aws-audit', tool: 'aws', name: 'CloudTrail: who changed what', kind: 'signal', fields: 'EventName, EventTime, Username, EventSource, Resources', paths: [MCP('AWS MCP servers (CloudTrail, or the AWS API server)', 'lookup_events', 'lookup_cloudtrail_events', 'call_aws'), LISTED(DT('fetch logs | filter log.source == "aws.cloudtrail" (if forwarded)'))], usedBy: ['agent: cloud_changes'], status: 'built' },
  { id: 'aws-cloudwatch', tool: 'aws', name: 'CloudWatch metrics and alarms', kind: 'signal', fields: 'alarms, metrics for managed services (RDS, SQS, ALB)', paths: [LISTED(DT('Dynatrace AWS integration: cloud.aws.* metrics')), LISTED(MCP('AWS MCP servers (CloudWatch)', 'get_metric_data', 'describe_alarms'))], usedBy: ['not used yet: next candidate evidence for managed-service failures (RDS, SQS, ALB)'], status: 'catalogued' },
  { id: 'aws-eks', tool: 'aws', name: 'EKS clusters and node groups', kind: 'signal', fields: 'cluster version, node group scaling, instance types', paths: [DT('Dynatrace Operator on EKS'), MCP('Amazon EKS MCP server', 'list_k8s_resources')], usedBy: ['agent: k8s_workload'], status: 'built' },

  // ---------- Azure ----------
  { id: 'azure-cost', tool: 'azure', name: 'Cost by product tag', kind: 'signal', fields: 'service, tag, environment, pre-tax cost', paths: [REST('Cost Management query API'), LISTED(MCP('Azure MCP server', 'cost_query'))], usedBy: ['collector: azure'], status: 'built' },
  { id: 'azure-audit', tool: 'azure', name: 'Activity Log: who changed what', kind: 'signal', fields: 'operationName, caller, status, resourceId, eventTimestamp', paths: [MCP('Azure MCP server / AKS MCP server', 'monitor_activitylog_list', 'az_monitor_activity_log', 'call_az'), LISTED(DT('fetch logs | filter azure.resource.id (if forwarded)'))], usedBy: ['agent: cloud_changes'], status: 'built' },
  { id: 'azure-monitor', tool: 'azure', name: 'Azure Monitor and AKS', kind: 'signal', fields: 'AKS node and pod state, Monitor metrics', paths: [DT('Dynatrace Azure integration and Operator on AKS'), MCP('AKS MCP server (preview)', 'list_k8s_resources')], usedBy: ['agent: k8s_workload'], status: 'built' },

  // ---------- Google Cloud ----------
  { id: 'gcp-cost', tool: 'gcp', name: 'Cost by product label (Billing export)', kind: 'signal', fields: 'service, sku, usage_start_time, labels, cost', paths: [REST('BigQuery jobs.query on the billing export'), LISTED(MCP('Google Cloud BigQuery MCP server', 'execute_sql', 'query'))], usedBy: ['collector: gcp'], status: 'built' },
  { id: 'gcp-audit', tool: 'gcp', name: 'Cloud Audit Logs: who changed what', kind: 'signal', fields: 'protoPayload.methodName, authenticationInfo.principalEmail, resourceName, timestamp', paths: [MCP('Google Cloud Logging MCP server', 'list_log_entries', 'query_logs'), LISTED(DT('fetch logs | filter gcp.resource.type (if forwarded)'))], usedBy: ['agent: cloud_changes'], status: 'built' },
  { id: 'gcp-gke', tool: 'gcp', name: 'GKE, Cloud Monitoring, Cloud Trace', kind: 'signal', fields: 'GKE workload state, metrics, traces', paths: [DT('Dynatrace Google Cloud integration and Operator on GKE'), MCP('Google Cloud GKE MCP server', 'list_k8s_resources')], usedBy: ['agent: k8s_workload'], status: 'built' },

  // ---------- GitHub ----------
  { id: 'gh-delivery', tool: 'github', name: 'PRs, commits, CI jobs, failure annotations, repo files', kind: 'signal', fields: 'pulls, jobs, check-run annotations, contents', paths: [REST('REST v2022-11-28'), MCP('github-mcp', 'get_pull_request_files', 'get_job_logs')], usedBy: ['collector: github', 'agent: gh_pr_files, gh_job_log'], status: 'built' },
  { id: 'gh-security', tool: 'github', name: 'Code scanning and Dependabot alerts', kind: 'signal', fields: 'rule, severity, state, file, CVE', paths: [MCP('github-mcp', 'list_code_scanning_alerts', 'list_dependabot_alerts'), LISTED(REST('code-scanning/alerts, dependabot/alerts'))], usedBy: ['agent: security_findings'], status: 'built' },
  { id: 'gh-copilot', tool: 'github', name: 'Copilot coding agent: fix after approval', kind: 'action', fields: 'issue created from the approved recommendation, assigned to Copilot, which opens a draft PR', paths: [MCP('github-mcp (write, allowlist required)', 'create_issue', 'assign_copilot_to_issue')], usedBy: ['agent: after approval'], status: 'built-optional' },

  // ---------- Argo CD ----------
  { id: 'argo-apps', tool: 'argocd', name: 'Applications: sync and health', kind: 'signal', fields: 'sync status, health, operation phase and message', paths: [LISTED(DT('SDLC events from Argo CD notifications')), MCP('argocd-mcp (argoproj-labs)', 'get_application', 'list_applications'), REST('/api/v1/applications')], usedBy: ['collector: argocd', 'agent: argo_app'], status: 'built' },

  // ---------- ServiceNow ----------
  { id: 'snow-cmdb', tool: 'servicenow', name: 'CMDB business applications and change requests', kind: 'signal', fields: 'business app, owner, criticality, repos, services, namespaces, cost tag; change state, risk, approval', paths: [REST('Table API'), LISTED(MCP('ServiceNow MCP Server Console (Zurich+, Now Assist)', 'table_query'))], usedBy: ['collector: servicenow'], status: 'built' },
  { id: 'snow-knowledge', tool: 'servicenow', name: 'Incidents, problems, knowledge articles', kind: 'signal', fields: 'incident number, description, close notes; kb_knowledge text', paths: [LISTED(REST('Table API incident, problem, kb_knowledge')), LISTED(MCP('ServiceNow MCP Server Console', 'table_query', 'search_knowledge'))], usedBy: ['agent: kb_similar (knowledge base built from dummy ServiceNow-shaped records until this is connected)'], status: 'catalogued' },
  { id: 'snow-agent', tool: 'servicenow', name: 'Now Assist incident agent: similar incidents and resolution', kind: 'vendor-agent', fields: "ServiceNow's own similar-incident search and proposed resolution", paths: [MCP('ServiceNow MCP Server Console exposing Now Assist skills', 'now_assist_similar_incidents', 'incident_resolution_recommendation')], usedBy: ['agent: vendor_assessment'], status: 'built-optional' },

  // ---------- vendor investigation agents (asked in parallel; each answer must be backed by raw data) ----------
  { id: 'aws-agent', tool: 'aws', name: 'AWS DevOps Agent investigation', kind: 'vendor-agent', fields: 'journal records: observations, root cause analysis, mitigation plan', paths: [MCP('AWS MCP Server (call_aws runs devops-agent list-journal-records)', 'call_aws', 'aws___call_aws')], usedBy: ['agent: vendor_assessment'], status: 'built-optional' },
  { id: 'azure-agent', tool: 'azure', name: 'Azure SRE Agent thread', kind: 'vendor-agent', fields: "the agent's investigation answer in a thread", paths: [MCP('Azure MCP Server (sreagent_ tools)', 'sreagent_threads_create')], usedBy: ['agent: vendor_assessment'], status: 'built-optional' },
  { id: 'gcp-agent', tool: 'gcp', name: 'Gemini Cloud Assist investigation', kind: 'vendor-agent', fields: 'ranked observations and hypotheses', paths: [MCP('Cloud Assist investigations (tool names to confirm)', 'create_investigation', 'run_investigation'), LISTED(REST('Gemini Cloud Assist investigations API'))], usedBy: ['agent: vendor_assessment'], status: 'built-optional' },
  { id: 'k8sgpt', tool: 'kubernetes', name: 'K8sGPT analysis', kind: 'vendor-agent', fields: 'one result per broken object: kind, name, error text, details', paths: [MCP('k8sgpt MCP server (tool names to confirm)', 'analyze', 'k8sgpt_analyze'), LISTED(REST('k8sgpt analyze --explain -o json'))], usedBy: ['agent: vendor_assessment'], status: 'built-optional' },

  // ---------- anything else ----------
  { id: 'custom', tool: 'any', name: 'Any other or in-house tool', kind: 'signal', fields: "the tool's own records, in its own schema", paths: [{ via: 'custom', how: 'Wrap it once as an MCP server (templates/custom-mcp-server), list it in mcp.servers.json, map its tool in toolMap' }], usedBy: ['agent and collector, through the same tool map'], status: 'pattern' },
]
