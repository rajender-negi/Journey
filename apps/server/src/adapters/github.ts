// GitHub REST API (v2022-11-28): merged PRs, workflow jobs with failure annotations, repo contents.
import type { GhAnnotation, GhCommit, GhContent, GhJob, GhPull, RawBundle } from '@pj/core'
import { config } from '../config'
import { getJson, pool } from './http'

const H = () => ({ Authorization: `Bearer ${config.github.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' })
const api = (p: string) => `${config.github.api}${p}`

// files worth analysing; everything else is skipped to stay inside rate limits
const INTERESTING = /(^|\/)(Dockerfile|package\.json|pom\.xml|build\.gradle|go\.mod|requirements\.txt|pyproject\.toml|CODEOWNERS)$|\.github\/(workflows\/.*\.ya?ml|dependabot\.ya?ml)$|(^|\/)(k8s|deploy|helm|manifests|charts)\/.*\.ya?ml$|\.tf$|^(src|app|internal|cmd|lib)\/.*\.(ts|js|py|java|go|cs)$/

export async function fetchGitHub(repos: string[], windowDays: number): Promise<RawBundle['github']> {
  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString()
  const pulls: GhPull[] = []
  const prCommits: Record<string, GhCommit[]> = {}
  const jobs: GhJob[] = []
  const annotations: Record<string, GhAnnotation[]> = {}
  const contents: Record<string, GhContent[]> = {}

  await pool(repos, 3, async (repo) => {
    // merged PRs in window
    const list = await getJson<GhPull[]>(api(`/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100`), H())
    const merged = list.filter((p) => p.merged_at && p.merged_at >= since)
    await pool(merged, 4, async (p) => {
      const full = await getJson<GhPull>(api(`/repos/${repo}/pulls/${p.number}`), H())
      pulls.push(full)
      prCommits[`${repo}#${p.number}`] = await getJson<GhCommit[]>(api(`/repos/${repo}/pulls/${p.number}/commits?per_page=100`), H())
    })

    // workflow runs -> jobs -> failure annotations
    const runs = await getJson<{ workflow_runs: { id: number }[] }>(api(`/repos/${repo}/actions/runs?created=>=${since.slice(0, 10)}&per_page=100`), H())
    await pool(runs.workflow_runs, 4, async (r) => {
      const js = await getJson<{ jobs: GhJob[] }>(api(`/repos/${repo}/actions/runs/${r.id}/jobs`), H())
      jobs.push(...js.jobs)
      for (const j of js.jobs.filter((x) => x.conclusion === 'failure' || x.conclusion === 'timed_out')) {
        annotations[String(j.id)] = await getJson<GhAnnotation[]>(api(`/repos/${repo}/check-runs/${j.id}/annotations`), H())
      }
    })

    // repo snapshot for phase 4
    const tree = await getJson<{ tree: { path: string; type: string }[] }>(api(`/repos/${repo}/git/trees/HEAD?recursive=1`), H())
    const paths = tree.tree.filter((t) => t.type === 'blob' && INTERESTING.test(t.path)).slice(0, config.github.maxFilesPerRepo).map((t) => t.path)
    contents[repo] = await pool(paths, 6, (p) => getJson<GhContent>(api(`/repos/${repo}/contents/${encodeURI(p)}`), H()))
  })
  return { pulls, prCommits, jobs, annotations, contents }
}
