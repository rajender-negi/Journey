// ServiceNow Table API: cmdb_ci_business_app (product identity) and change_request.
import type { RawBundle, SnowBusinessApp, SnowChange } from '@pj/core'
import { FIELD_MAP } from '@pj/core'
import { config } from '../config'
import { getJson } from './http'

const REFS = new Set(['owned_by', 'support_group', 'cmdb_ci'])

function headers(): Record<string, string> {
  const c = config.servicenow
  return c.token ? { Authorization: `Bearer ${c.token}` } : { Authorization: `Basic ${Buffer.from(`${c.user}:${c.password}`).toString('base64')}` }
}

// sysparm_display_value=all returns {value, display_value} for every field; keep that shape for
// references and flatten everything else to the raw value, which is what the mapper expects.
function flatten(row: Record<string, { value: string; display_value: string; link?: string }>) {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, REFS.has(k) ? v : v?.value ?? v]))
}

export async function fetchServiceNow(windowDays: number): Promise<RawBundle['servicenow']> {
  const base = `https://${config.servicenow.instance}.service-now.com/api/now/table`
  const f = FIELD_MAP.cmdb
  const appFields = ['sys_id', 'number', 'name', 'owned_by', 'support_group', 'business_criticality', f.repos, f.services, f.namespaces, f.costTag, f.downtimeCost].join(',')
  const apps = await getJson<{ result: Record<string, never>[] }>(
    `${base}/cmdb_ci_business_app?sysparm_query=${encodeURIComponent(config.servicenow.productQuery)}&sysparm_fields=${appFields}&sysparm_display_value=all&sysparm_limit=500`,
    headers(),
  )
  const businessApps = apps.result.map(flatten) as unknown as SnowBusinessApp[]
  const ids = businessApps.map((a) => a.sys_id).join(',')
  const chgFields = 'sys_id,number,state,risk,type,approval,opened_at,approval_set,start_date,end_date,closed_at,close_code,cmdb_ci,correlation_id'
  const q = `cmdb_ciIN${ids}^opened_at>=javascript:gs.daysAgoStart(${windowDays})`
  const chg = await getJson<{ result: Record<string, never>[] }>(
    `${base}/change_request?sysparm_query=${encodeURIComponent(q)}&sysparm_fields=${chgFields}&sysparm_display_value=all&sysparm_limit=5000`,
    headers(),
  )
  // display_value=all returns state/risk as {value:'-3', display_value:'Authorize'}; flatten keeps value
  return { businessApps, changes: chg.result.map(flatten) as unknown as SnowChange[] }
}
