// The one UI for every device. Plain ES2017, no framework, no external requests.
// Data is the view model from core: embedded as window.VM in the published page, or fetched
// from the API (/api/vm, gzipped) when served by the server. Same renderer either way.
(function () {
  'use strict'
  var VM = window.VM || null
  var SERVED = !window.VM
  // published card: the LangGraph agent runs in this page (agent.js, loaded on first Investigate)
  if (VM && !VM.agent) VM.agent = { enabled: true, local: true, llm: null, mcpServers: [] }
  var NOW = Date.now()
  var S = { pid: 'all', tab: 'map', cfg: null, cardMode: 'demo', cardOffList: [], openTool: null, mapBusy: false, outcome: 'all', pillar: 'all', limit: 20, openJ: {}, openG: null, ai: {}, runs: {}, openA: null, itest: {}, paste: {} }
  var h = location.hash.replace('#', '')
  var TABS = [['map', 'Map'], ['overview', 'Overview'], ['journeys', 'Journeys'], ['fixes', 'Fixes'], ['prevent', 'Prevent'], ['advisor', 'Advisor'], ['code', 'Codebase'], ['cost', 'Cost'], ['practices', 'Practices'], ['integrations', 'Integrations']]
  if (TABS.some(function (t) { return t[0] === h })) S.tab = h

  // ---------- helpers ----------
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] }) }
  function prod(id) { for (var i = 0; i < VM.products.length; i++) if (VM.products[i].id === id) return VM.products[i]; return null }
  function pname(id) { var p = prod(id); return p ? p.n : id }
  function inP(xs) { return S.pid === 'all' ? xs : xs.filter(function (x) { return x.pid === S.pid }) }
  function last(xs) { return xs[xs.length - 1] }
  function usd(n) { n = Math.round(n); if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M'; return Math.abs(n) >= 1000 ? '$' + (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'k' : '$' + n }
  function usdFull(n) { return '$' + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',') }
  function hrs(x) { return x < 1 ? Math.round(x * 60) + 'm' : x < 48 ? x.toFixed(1) + 'h' : (x / 24).toFixed(1) + 'd' }
  function pct(x) { return (x * 100).toFixed(x < 0.1 ? 1 : 0) + '%' }
  function ago(iso) {
    var m = (NOW - Date.parse(iso)) / 60000
    if (m < 1) return 'just now'
    if (m < 60) return Math.round(m) + 'm ago'
    if (m < 2880) return Math.round(m / 60) + 'h ago'
    return Math.round(m / 1440) + 'd ago'
  }
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  function when(iso) { // IST without Intl timezone support
    var d = new Date(Date.parse(iso) + 330 * 60000)
    function p2(n) { return n < 10 ? '0' + n : '' + n }
    return d.getUTCDate() + ' ' + MON[d.getUTCMonth()] + ', ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes())
  }
  function chip(text, tone) { return '<span class="chip ' + (tone || '') + '">' + esc(text) + '</span>' }
  var BAND = { elite: 'Elite', high: 'High', medium: 'Medium', low: 'Low' }
  function band(b) { return chip(BAND[b], 'band-' + b) }
  function sev(s) { return chip(s, 'sev-' + s) }
  function bar(v, max, tone) { return '<div class="bar"><i class="' + (tone || '') + '" style="width:' + Math.max(2, Math.min(100, (v / (max || 1)) * 100)) + '%"></i></div>' }
  function refs(rs) { return rs && rs.length ? '<ul class="refs">' + rs.map(function (i) { var r = typeof i === 'number' ? VM.refs[i] : i; return '<li><a href="' + esc(r[1]) + '" target="_blank" rel="noreferrer">' + esc(r[0]) + '</a></li>' }).join('') + '</ul>' : '' }
  function section(title, aside, body) { return '<section class="section"><div class="section-head"><h2>' + esc(title) + '</h2>' + (aside ? '<span class="muted small">' + aside + '</span>' : '') + '</div>' + body + '</section>' }
  function cr(c) { return VM.codeRules[c.rule] }
  function hiSev(c) { var s = cr(c).s; return s === 'critical' || s === 'high' }
  function pillarLabel(id) { for (var i = 0; i < VM.pillars.length; i++) if (VM.pillars[i][0] === id) return VM.pillars[i][1]; return id }

  // ---------- AI ----------
  var samplePromise = null
  function getSample() {
    if (!samplePromise) {
      samplePromise = (window.claude && window.claude.use) ? window.claude.use('sample').catch(function () { return null }) : Promise.resolve(null)
    }
    return samplePromise
  }
  function packFor(mode, target) {
    if (mode === 'portfolio') {
      return { mode: mode, portfolioDora: VM.scopes.all.dora, products: VM.products.map(function (p) {
        var sc = VM.scopes[p.id]
        var rulesSeen = {}
        VM.failures.forEach(function (f) { if (f.pid === p.id && f.rule !== 'FX-NON-CHANGE') rulesSeen[f.rule] = (rulesSeen[f.rule] || 0) + 1 })
        return { name: p.n, tier: p.tier, dora: sc.dora, grade: VM.scores[p.id].g, monthlyCost: sc.cost.cur, savings: sc.cost.save, failureCost: sc.cost.fail, failureRules: rulesSeen }
      }) }
    }
    if (mode === 'product') {
      var p = prod(target), sc = VM.scopes[target], counts = {}
      VM.failures.forEach(function (f) { if (f.pid === target && f.rule !== 'FX-NON-CHANGE') counts[f.rule] = (counts[f.rule] || 0) + 1 })
      return { mode: mode, product: { id: p.id, name: p.n, tier: p.tier, owner: p.o, team: p.t }, dora: sc.dora,
        failureRules: Object.keys(counts).map(function (k) { return { ruleId: k, count: counts[k], title: VM.rules[k].t } }),
        pendingRisk: VM.risks.filter(function (r) { return r.pid === target }).map(function (r) { return { score: r.s, gate: r.g, factors: r.f.map(function (x) { return x[1] }) } }),
        codeFindings: VM.code.filter(function (c) { return c.pid === target && hiSev(c) }).map(function (c) { return { ruleId: c.rule, severity: cr(c).s, title: cr(c).t, evidence: c.ev } }),
        scorecard: VM.scores[target], cost: { currentMonth: sc.cost.cur, momChangePct: sc.cost.mom, topSavings: sc.cost.ins.slice(0, 5).map(function (i) { return { title: i[1], monthlySavingsUsd: i[3] } }) } }
    }
    var f = VM.failures.filter(function (x) { return x.id === target })[0]
    var j = VM.journeys.filter(function (x) { return x.f === target })[0]
    var r = VM.rules[f.rule]
    return { mode: 'finding', product: { name: pname(f.pid), tier: (prod(f.pid) || {}).tier },
      finding: { at: f.at, source: f.src, category: f.cat, evidence: f.ev, ruleId: f.rule, title: r.t, fixNow: r.now, prevent: r.prev },
      journey: j ? { title: j.t, author: j.au, stages: j.st.map(function (s, i) { return VM.stageNames[i] + ':' + s[0] + (s[2] != null ? ':' + s[2] + 'm' : '') }) } : null,
      relatedCodeFindings: VM.code.filter(function (c) { return c.pid === f.pid && hiSev(c) }).slice(0, 6).map(function (c) { return { ruleId: c.rule, title: cr(c).t, evidence: c.ev } }),
      dora: VM.scopes[f.pid] ? VM.scopes[f.pid].dora : null }
  }
  function ask(mode) {
    return mode === 'finding' ? 'Explain this failure: probable root cause chain across the sources, business impact, and the ordered actions to restore now and prevent recurrence.'
      : mode === 'product' ? 'Brief the product owner: the one-line state of delivery health, the root pattern behind failures, and the top 5 actions ranked by MTTR and failure-rate impact.'
        : 'Brief engineering leadership on the portfolio: which product needs intervention first and why, and the top 5 cross-product actions ranked by risk reduction and savings.'
  }
  function rulesOnly(mode, target) {
    if (mode === 'finding') {
      var f = VM.failures.filter(function (x) { return x.id === target })[0], r = VM.rules[f.rule]
      return { headline: f.cat + ': ' + r.t, rootCause: r.sum, impact: f.src + ' failure on ' + pname(f.pid) + '.',
        actions: r.now.map(function (x) { return { action: x, ruleId: f.rule, horizon: 'now', owner: 'on-call' } }).concat(r.prev.map(function (x) { return { action: x, ruleId: f.rule, horizon: 'this-sprint', owner: 'product team' } })) }
    }
    var counts = {}
    VM.failures.forEach(function (f) { if ((mode === 'portfolio' || f.pid === target) && f.rule !== 'FX-NON-CHANGE') counts[f.rule] = (counts[f.rule] || 0) + 1 })
    var top = Object.keys(counts).sort(function (x, y) { return counts[y] - counts[x] }).slice(0, 5)
    var d = VM.scopes[mode === 'portfolio' ? 'all' : target].dora
    return { headline: 'CFR ' + pct(d.cfr) + ' (' + d.b.changeFailureRate + '), lead time ' + hrs(d.lt) + ' (' + d.b.leadTime + '), MTTR ' + hrs(d.mttr) + ' (' + d.b.mttr + ')',
      rootCause: top.length ? 'Most frequent failure pattern: ' + VM.rules[top[0]].t + ' (' + counts[top[0]] + ' occurrences).' : 'No change-caused failures in the window.',
      impact: 'Failure cost this window: ' + usdFull(VM.scopes[mode === 'portfolio' ? 'all' : target].cost.fail) + '.',
      actions: top.map(function (k, i) { return { action: VM.rules[k].prev[0], ruleId: k, horizon: i === 0 ? 'now' : 'this-sprint', owner: 'product team' } }) }
  }
  function parseOut(text, packText) {
    var s = text.indexOf('{'), e = text.lastIndexOf('}')
    var o = JSON.parse(text.slice(s, e + 1))
    o.actions = (o.actions || []).filter(function (a) { return a && a.ruleId && packText.indexOf(a.ruleId) >= 0 })
    if (!o.headline || !o.actions.length) throw new Error('invalid')
    return o
  }
  function runBrief(key, mode, target) {
    S.ai[key] = { busy: true }
    render()
    var pack = packFor(mode, target), packText = JSON.stringify(pack)
    var prompt = VM.sys + '\n\n' + ask(mode) + '\n\nEvidence pack:\n' + packText
    var viaServer = SERVED && !(window.claude && window.claude.use)
    var job = viaServer ? serverBrief(mode, target) : getSample().then(function (sample) {
      if (!sample) return { out: rulesOnly(mode, target), llm: false, note: 'Claude is not reachable from this view.' }
      return sample(prompt).then(function (res) {
        try { return { out: parseOut(res.text, packText), llm: true } } catch (e) { return { out: rulesOnly(mode, target), llm: false, note: 'The model answer did not pass validation.' } }
      }, function (err) {
        var code = err && err.code
        var note = code === 'not_granted' ? 'Claude access was declined.' : code === 'rate_limited' ? 'Too many requests. Try again in a minute.' : 'Claude did not answer.'
        return { out: rulesOnly(mode, target), llm: false, note: note }
      })
    })
    job.then(function (r) { S.ai[key] = r; render() })
  }
  function serverBrief(mode, target) {
    return fetch('api/ai/brief', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: mode, target: target }) })
      .then(function (r) { return r.json() })
      .then(function (j) { return { out: j.output, llm: j.engine === 'llm', note: j.engine === 'llm' ? '' : (j.reason || '') } })
      .catch(function () { return { out: rulesOnly(mode, target), llm: false, note: 'The server did not answer.' } })
  }
  // ---------- agentic investigation (LangGraph + MCP, served mode only) ----------
  function agentCall(path, body) {
    return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j }) })
  }
  // in-page agent (published card): load agent.js once, Claude via the sample capability when allowed
  var localAgentPromise = null, agentLibPromise = null
  function agentLib() {
    if (!agentLibPromise) {
      agentLibPromise = new Promise(function (resolve, reject) {
        if (window.PJAgent) return resolve(window.PJAgent)
        var sc = document.createElement('script')
        sc.src = 'agent.js'
        sc.onload = function () { window.PJAgent ? resolve(window.PJAgent) : reject(new Error('agent.js loaded without PJAgent')) }
        sc.onerror = function () { reject(new Error('Could not load agent.js')) }
        document.head.appendChild(sc)
      })
      agentLibPromise.catch(function () { agentLibPromise = null })
    }
    return agentLibPromise
  }
  function localAgent() {
    if (!localAgentPromise) {
      localAgentPromise = agentLib().then(function (A) {
        return getSample().then(function (sample) { return A.create({ now: Date.parse(VM.at), sample: sample, off: cardOff() }) })
      })
      localAgentPromise.catch(function () { localAgentPromise = null })
    }
    return localAgentPromise
  }
  var NODE_LABEL = { classify: 'Classified', plan_evidence: 'Planned evidence', gather: 'Gathered evidence', hypothesize: 'Formed hypothesis', verify: 'Verified against evidence', recommend: 'Recommended actions' }
  function startAgent(fid) {
    S.runs[fid] = { busy: true, steps: [] }
    render()
    var job = VM.agent.local
      ? localAgent().then(function (ag) {
          VM.agent.llm = ag.model
          return ag.start(fid, function (node, log) { var st = S.runs[fid]; if (st && st.steps) { st.steps.push((NODE_LABEL[node] || node) + (log && log.length ? ': ' + log[log.length - 1].slice(9) : '')); render() } })
        })
      : agentCall('api/agent/investigate', { findingId: fid })
    job.then(function (v) { S.runs[fid] = { view: v } }, function (e) { S.runs[fid] = { error: e.message } }).then(render)
  }
  function decideAgent(fid, decision) {
    var cur = S.runs[fid]
    S.runs[fid] = { busy: true, view: cur.view }
    render()
    var job = VM.agent.local
      ? localAgent().then(function (ag) { return ag.resume(cur.view.id, decision, 'you') })
      : agentCall('api/agent/runs/' + encodeURIComponent(cur.view.id) + '/resume', { decision: decision, by: 'web user' })
    job.then(function (v) { S.runs[fid] = { view: v } }, function (e) { S.runs[fid] = { view: cur.view, error: e.message } }).then(render)
  }
  // knowledge-base matches (RAG) shown under their evidence line
  function kbHits(data) {
    try {
      var m = JSON.parse(data).matches || []
      return '<ul class="factors small">' + m.slice(0, 5).map(function (h) { return '<li><code>' + esc(h.ref) + '</code> ' + esc(h.source) + (h.source === 'runbook' || h.sameProduct ? '' : ' · other product') + ' · ' + esc(h.via) + '<br><span class="muted">' + esc((h.resolution || h.snippet || '').slice(0, 160)) + '</span></li>' }).join('') + '</ul>'
    } catch (x) { return '' }
  }
  var RUN_TONE = { awaiting_approval: 'tone-warn', approved: 'tone-good', rejected: 'sev-critical', failed: 'sev-critical', running: 'tone-accent' }
  function agentBox(fid) {
    var st = S.runs[fid] || {}
    var sub = VM.agent.local
      ? 'LangGraph agent running in this page: plans evidence, fetches it from native-schema snapshots (the same shapes Dynatrace, GitHub, Argo CD and Kubernetes MCP servers return), searches past incidents and runbooks (keyword + vector RAG), tests its hypothesis against the evidence, and waits for your approval. Approved runs are remembered as precedent. Claude is the model through LangChain when you allow it; otherwise rules.'
      : 'LangGraph agent: plans evidence, fetches it through MCP (read only), tests its hypothesis against the evidence, and waits for your approval. ' + (VM.agent.mcpServers.length ? 'MCP: ' + VM.agent.mcpServers.join(', ') : 'No MCP servers: reads the loaded source data through the same operations') + (VM.agent.llm ? ' · model ' + VM.agent.llm : ' · rules only (no AI key)')
    var html = '<div class="ai agent"><div class="ai-head"><div><div class="eyebrow">Agent investigation</div><div class="ai-sub">' + esc(sub) + '</div></div>'
    if (!st.view || st.view.status === 'failed') html += '<button class="btn primary" data-act="agent" data-id="' + esc(fid) + '"' + (st.busy ? ' disabled' : '') + '>' + (st.busy ? 'Investigating…' : 'Investigate') + '</button>'
    html += '</div>'
    if (st.busy && !st.view) html += '<div class="ai-wait">' + (st.steps && st.steps.length ? '<ol class="ai-actions">' + st.steps.map(function (x) { return '<li>' + esc(x) + '</li>' }).join('') + '</ol>' : 'Starting the agent. Each Claude step can take up to a minute.') + '</div>'
    if (st.error) html += '<p class="note">' + esc(st.error) + '</p>'
    var v = st.view
    if (v && v.state) {
      var s = v.state
      html += '<div class="ai-engine">' + chip(v.status.replace('_', ' '), RUN_TONE[v.status]) + (s.hypothesis ? chip('confidence ' + s.hypothesis.confidence, '') : '') + (s.verification ? chip(s.verification.passed ? 'verified' : 'not fully verified', s.verification.passed ? 'tone-good' : 'tone-warn') : '') + '</div>'
      if (s.recommendation) html += '<p class="ai-headline">' + esc(s.recommendation.headline) + '</p>'
      if (s.hypothesis) html += '<h4>Root cause chain</h4><ol class="ai-actions">' + s.hypothesis.chain.map(function (c) { return '<li><span class="ai-action">' + esc(c.step) + '</span><span class="ai-meta">' + c.evidenceIds.map(function (x) { return '<code>' + esc(x) + '</code>' }).join(' ') + '</span></li>' }).join('') + '</ol>'
      html += '<h4>Evidence</h4><ul class="factors">' + (s.evidence || []).map(function (e) { return '<li><code>' + esc(e.id) + '</code> ' + (e.ok ? '' : '<span class="t-crit">unavailable</span> ') + esc(e.source) + (e.tool ? ' · <code>' + esc(e.server + ':' + e.tool) + '</code>' : '') + ' <span class="muted">· ' + esc(e.summary) + '</span>' + (e.flags && e.flags.length ? ' <span class="t-warn">' + esc(e.flags.join(', ')) + '</span>' : '') + (e.kind === 'kb_similar' && e.ok ? kbHits(e.data) : '') + '</li>' }).join('') + '</ul>'
      if (s.verification) html += '<h4>Verification</h4><ul class="factors">' + s.verification.checks.map(function (c) { return '<li>' + (c.ok ? '<span class="t-good">pass</span>' : '<span class="t-crit">fail</span>') + ' ' + esc(c.name) + ' <span class="muted">· ' + esc(c.detail) + '</span></li>' }).join('') + '</ul>'
      if (s.recommendation) html += '<h4>Actions</h4><ol class="ai-actions">' + s.recommendation.actions.map(function (x) { return '<li><span class="ai-action">' + esc(x.action) + '</span><span class="ai-meta"><code>' + esc(x.ruleId) + '</code> · ' + esc(String(x.horizon).replace('-', ' ')) + ' · ' + esc(x.owner) + '</span></li>' }).join('') + '</ol>'
      if (v.status === 'awaiting_approval') html += '<div class="nav-row"><button class="btn primary" data-act="agent-ok" data-id="' + esc(fid) + '"' + (st.busy ? ' disabled' : '') + '>Approve</button> <button class="btn" data-act="agent-no" data-id="' + esc(fid) + '"' + (st.busy ? ' disabled' : '') + '>Reject</button></div>'
      if (s.log && s.log.length) html += '<details><summary class="muted small">Agent log (' + s.log.length + ' steps)</summary><pre class="evidence">' + esc(s.log.join('\n')) + '</pre></details>'
      if (v.handoff) html += '<p class="small t-good">' + esc(v.handoff) + '</p>'
      if (v.trace && v.trace.length) {
        var depth = {}, lines = v.trace.map(function (t) { depth[t.id] = t.parent && depth[t.parent] != null ? depth[t.parent] + 1 : 0; var at = t.attrs || {}; return new Array(depth[t.id] + 1).join('  ') + t.name + (t.ms != null ? '  ' + t.ms + ' ms' : '') + (t.status === 'error' ? '  ERROR ' + (t.error || '') : '') + (at['gen_ai.request.model'] ? '  model ' + at['gen_ai.request.model'] : '') + (at['app.tool.server'] ? '  via ' + at['app.tool.server'] : '') })
        html += '<details><summary class="muted small">Trace (' + v.trace.length + ' spans, OpenTelemetry GenAI names)</summary><pre class="evidence">' + esc(lines.join('\n')) + '</pre></details>'
      }
    }
    return html + '</div>'
  }

  function aiBox(mode, target, label) {
    var key = mode + ':' + target, st = S.ai[key]
    var html = '<div class="ai"><div class="ai-head"><div><div class="eyebrow">AI analysis</div><div class="ai-sub">Rules classify the evidence. Claude links it across sources and ranks the actions. Every action cites a rule.</div></div>' +
      '<button class="btn primary" data-act="ai" data-mode="' + mode + '" data-target="' + esc(target) + '"' + (st && st.busy ? ' disabled' : '') + '>' + (st && st.busy ? 'Analysing…' : st ? 'Run again' : label) + '</button></div>'
    if (st && st.busy) html += '<div class="ai-wait">Thinking. Long briefs take up to a minute.</div>'
    if (st && st.out) {
      var o = st.out
      html += '<div class="ai-body"><div class="ai-engine">' + chip(st.llm ? 'Claude' : 'Rules only', st.llm ? 'tone-accent' : '') + (st.note ? ' <span class="muted small">' + esc(st.note) + '</span>' : '') + '</div>' +
        '<p class="ai-headline">' + esc(o.headline) + '</p><dl class="ai-dl"><dt>Root cause</dt><dd>' + esc(o.rootCause) + '</dd><dt>Impact</dt><dd>' + esc(o.impact) + '</dd></dl>' +
        '<ol class="ai-actions">' + o.actions.map(function (a) { return '<li><span class="ai-action">' + esc(a.action) + '</span><span class="ai-meta"><code>' + esc(a.ruleId) + '</code> · ' + esc(String(a.horizon || '').replace('-', ' ')) + ' · ' + esc(a.owner || '') + '</span></li>' }).join('') + '</ol></div>'
    }
    return html + '</div>'
  }

  // ---------- views ----------
  function overview() {
    var sc = VM.scopes[S.pid], d = sc.dora
    var maxW = Math.max.apply(null, d.weekly.map(function (w) { return w[1] }).concat([1]))
    var weekly = '<div class="wbars" role="img" aria-label="Production deployments per week">' + d.weekly.map(function (w) {
      var ok = w[1] - w[2]
      return '<div class="wbar" title="' + w[0] + ': ' + w[1] + ' deploys, ' + w[2] + ' failed"><i class="bad" style="height:' + (w[2] / maxW * 100) + '%"></i><i class="ok" style="height:' + (ok / maxW * 100) + '%"></i></div>'
    }).join('') + '</div><div class="wlabels">' + d.weekly.map(function (w) { return '<span>' + w[0] + '<br>' + w[1] + '</span>' }).join('') + '</div>' +
      '<div class="legend"><span><i class="sw m-good"></i>Delivered clean</span><span><i class="sw m-crit"></i>Failed or caused a problem</span></div>'
    var tiles = [['Deployment frequency', d.df + '/day', d.b.deploymentFrequency], ['Lead time for changes', hrs(d.lt), d.b.leadTime], ['Change failure rate', pct(d.cfr), d.b.changeFailureRate], ['Time to restore', hrs(d.mttr), d.b.mttr]]
    var src = d.src === 'computed' ? 'Computed from SDLC events' : d.src === 'dynatrace' ? 'From Dynatrace' : 'From Dynatrace, cross-checked'
    var maxF = Math.max.apply(null, sc.funnel.map(function (f) { return f[1] }).concat([1]))
    var funnel = '<div class="funnel">' + sc.funnel.map(function (f) {
      return '<div class="funnel-row"><span class="funnel-k">' + f[0] + '</span>' + bar(f[1], maxF, 'good') + '<span class="funnel-v num">' + f[1] + (f[2] ? '<b class="t-crit"> · ' + f[2] + ' failed</b>' : '') + (f[3] ? '<span class="t-warn"> · ' + f[3] + ' waiting</span>' : '') + '</span><span class="funnel-t num muted">' + (f[4] != null ? f[4] + 'm' : '') + '</span></div>'
    }).join('') + '</div><p class="muted small">Bars show changes that passed each stage. Right column is the median minutes in the stage.</p>'
    var out = aiBox(S.pid === 'all' ? 'portfolio' : 'product', S.pid, S.pid === 'all' ? 'Brief leadership' : 'Brief product owner')
    out += section('DORA', src + ' · last ' + VM.win + ' days', '<div class="tiles">' + tiles.map(function (t) { return '<div class="tile"><div class="tile-k">' + t[0] + '</div><div class="tile-v">' + t[1] + '</div>' + band(t[2]) + '</div>' }).join('') + '</div>' +
      (d.drift.length ? '<p class="note">Drift between Dynatrace and the computed value: ' + esc(d.drift.join('; ')) + '.</p>' : '') + weekly)
    if (S.pid !== 'all' && VM.advice && VM.advice[S.pid] && VM.advice[S.pid].best) out += section('Recommended first', '<a href="#advisor" data-act="tab" data-id="advisor">Advisor</a>', adviceCard(S.pid, VM.advice[S.pid].best, false))
    out += section('Where changes stop', (sc.funnel.length ? sc.funnel[0][1] : 0) + ' changes merged', funnel)
    if (S.pid === 'all') {
      out += section('Products', 'tap a row', '<div class="table-wrap"><table class="table"><thead><tr><th>Product</th><th class="r">Deploys/day</th><th class="r">Lead time</th><th class="r">CFR</th><th class="r">MTTR</th><th class="r">Grade</th><th class="r">Spend/mo</th></tr></thead><tbody>' +
        VM.products.map(function (p) {
          var pd = VM.scopes[p.id].dora, g = VM.scores[p.id].g
          return '<tr class="row-link" data-act="pid" data-id="' + p.id + '"><td><b>' + esc(p.n) + '</b><div class="muted small">' + esc(p.t) + ' · T' + p.tier + '</div></td><td class="r num">' + pd.df + '</td><td class="r num">' + hrs(pd.lt) + '</td><td class="r num' + (pd.b.changeFailureRate === 'low' ? ' t-crit' : '') + '">' + pct(pd.cfr) + '</td><td class="r num">' + hrs(pd.mttr) + '</td><td class="r"><span class="grade g-' + g + '">' + g + '</span></td><td class="r num">' + usd(VM.scopes[p.id].cost.cur) + '</td></tr>'
        }).join('') + '</tbody></table></div>')
    }
    out += section('Open problems', '', sc.open.length ? sc.open.map(function (p) { return '<div class="item"><div class="item-top">' + chip('open', 'sev-critical') + '<b>' + esc(p[0]) + '</b><span class="muted small">' + esc(pname(p[4])) + ' · ' + ago(p[3]) + '</span></div><div>' + esc(p[1]) + '</div><div class="muted small">' + esc(p[2]) + '</div></div>' }).join('') : '<p class="empty">No open Dynatrace problems.</p>')
    return out
  }

  var ST_CLASS = { d: 'done', f: 'failed', r: 'running', p: 'pending', s: 'skipped' }
  function pipe(st) { return '<ol class="pipe">' + st.map(function (s, i) { return '<li class="st st-' + ST_CLASS[s[0]] + '"><span class="dot"></span><span class="st-k">' + VM.stageNames[i] + '</span></li>' }).join('') + '</ol>' }
  function findingBody(f) {
    var r = VM.rules[f.rule]
    return '<div class="finding"><div class="item-top">' + sev(r.s) + '<b>' + esc(r.t) + '</b><code class="small">' + esc(f.rule) + '</code></div><pre class="evidence">' + esc(f.ev) + '</pre><p>' + esc(r.sum) + '</p>' +
      '<div class="two"><div><h4>Restore now</h4><ul>' + r.now.map(function (x) { return '<li>' + esc(x) + '</li>' }).join('') + '</ul></div><div><h4>Prevent recurrence</h4><ul>' + r.prev.map(function (x) { return '<li>' + esc(x) + '</li>' }).join('') + '</ul></div></div>' +
      refs(r.refs) + aiBox('finding', f.id, 'Explain this failure') + (VM.agent && VM.agent.enabled ? agentBox(f.id) : '') + '</div>'
  }
  var OUT = [['all', 'All'], ['failed', 'Failed'], ['delivered-with-incident', 'Caused a problem'], ['in-flight', 'In flight'], ['delivered', 'Delivered']]
  var OUT_TONE = { failed: 'sev-critical', 'delivered-with-incident': 'sev-high', 'in-flight': 'tone-warn', delivered: 'tone-good' }
  function journeys() {
    var all = inP(VM.journeys)
    var list = S.outcome === 'all' ? all : all.filter(function (j) { return j.o === S.outcome })
    var out = '<div class="filters">' + OUT.map(function (o) {
      var n = o[0] === 'all' ? all.length : all.filter(function (j) { return j.o === o[0] }).length
      return '<button class="fchip' + (S.outcome === o[0] ? ' on' : '') + '" data-act="outcome" data-id="' + o[0] + '">' + o[1] + ' <span class="num">' + n + '</span></button>'
    }).join('') + '</div><p class="muted small">' + (VM.totalJourneys > VM.journeys.length ? 'Latest ' + VM.journeys.length + ' of ' + VM.totalJourneys + ' changes. ' : '') + 'Each change from merge to main through build, test, scan, staging, change approval, production and Dynatrace verification. Tap a change for stage times and the fix.</p><div class="journeys">'
    out += list.slice(0, S.limit).map(function (j) {
      var key = j.repo + j.sha, open = S.openJ[key]
      var html = '<article class="journey' + (open ? ' open' : '') + '"><button class="journey-hit" data-act="journey" data-id="' + key + '"><div class="journey-top">' + chip(j.o === 'delivered-with-incident' ? 'caused problem' : j.o, OUT_TONE[j.o]) +
        '<span class="muted small">' + esc(pname(j.pid)) + ' · ' + esc(j.repo) + ' #' + j.pr + '</span><span class="muted small push">' + ago(j.m) + '</span></div><div class="journey-title">' + esc(j.t) + '</div>' + pipe(j.st) +
        '<div class="journey-meta muted small"><code>' + j.sha + '</code> · ' + esc(j.au) + (j.lt != null ? ' · lead time ' + hrs(j.lt) : '') + (j.b && j.o !== 'delivered' ? ' · stopped at ' + j.b : '') + '</div></button>'
      if (open) {
        html += '<div class="journey-detail"><table class="stages"><tbody>' + j.st.map(function (s, i) {
          return '<tr class="st-' + ST_CLASS[s[0]] + '"><td><span class="dot"></span> ' + VM.stageNames[i] + '</td><td class="muted small">' + (s[1] ? when(s[1]) : ST_CLASS[s[0]]) + '</td><td class="r num small">' + (s[2] != null ? s[2] + 'm' : '') + '</td><td class="small stage-detail">' + esc(s[3]) + '</td></tr>'
        }).join('') + '</tbody></table>'
        if (j.f) { var f = VM.failures.filter(function (x) { return x.id === j.f })[0]; if (f) html += findingBody(f) }
        html += '</div>'
      }
      return html + '</article>'
    }).join('') + '</div>'
    if (list.length > S.limit) out += '<button class="btn wide" data-act="more">Show ' + Math.min(20, list.length - S.limit) + ' more</button>'
    if (!list.length) out += '<p class="empty">No changes in this state.</p>'
    return out
  }

  function fixes() {
    var list = inP(VM.failures).filter(function (f) { return f.rule !== 'FX-NON-CHANGE' })
    var groups = {}, order = []
    list.forEach(function (f) { if (!groups[f.rule]) { groups[f.rule] = []; order.push(f.rule) } groups[f.rule].push(f) })
    order.sort(function (x, y) { return groups[y].length - groups[x].length })
    if (S.openG === null && order.length) S.openG = order[0]
    var max = order.length ? groups[order[0]].length : 1
    var out = '<p class="muted small">' + list.length + ' failures in ' + VM.win + ' days, grouped by cause. Fixing the top pattern removes the most failed deployments and restore time.</p>'
    out += order.map(function (rid) {
      var g = groups[rid], r = VM.rules[rid], open = S.openG === rid
      var names = []; g.forEach(function (f) { var n = pname(f.pid); if (names.indexOf(n) < 0) names.push(n) })
      return '<article class="group' + (open ? ' open' : '') + '"><button class="group-hit" data-act="group" data-id="' + rid + '"><div class="item-top">' + sev(r.s) + '<b>' + esc(g[0].cat) + '</b><span class="push num">' + g.length + '</span></div>' +
        bar(g.length, max, r.s === 'critical' || r.s === 'high' ? 'crit' : 'warn') + '<div class="muted small">' + esc(names.join(', ')) + ' · latest ' + ago(g[0].at) + '</div></button>' + (open ? findingBody(g[0]) : '') + '</article>'
    }).join('')
    return out + (order.length ? '' : '<p class="empty">No change-caused failures for this product.</p>')
  }

  function prevent() {
    var rs = inP(VM.risks).slice().sort(function (x, y) { return y.s - x.s })
    var out = '<p class="muted small">Changes not yet in production, scored before they deploy. Every point traces to a named factor. Hold means fix first; canary means progressive delivery with a Dynatrace guardian check.</p>'
    out += rs.map(function (r) {
      return '<article class="item"><div class="item-top">' + chip(r.g.replace(/-/g, ' '), r.g === 'hold' ? 'sev-critical' : r.g === 'proceed' ? 'tone-good' : 'tone-warn') + '<b>' + esc(r.t) + '</b><span class="push num risk-score">' + r.s + '</span></div>' +
        bar(r.s, 100, r.l === 'high' ? 'crit' : r.l === 'medium' ? 'warn' : 'good') + '<div class="muted small">' + esc(pname(r.pid)) + ' · <code>' + r.sha + '</code> · waiting at ' + esc(r.b || 'pipeline') + '</div>' +
        '<ul class="factors">' + r.f.map(function (x) { return '<li><span class="num">+' + x[0] + '</span> ' + esc(x[1]) + ' <span class="muted">· ' + esc(x[2]) + '</span></li>' }).join('') + '</ul></article>'
    }).join('')
    return out + (rs.length ? '' : '<p class="empty">No changes waiting to deploy.</p>')
  }

  var SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }
  function code() {
    var all = inP(VM.code)
    var list = (S.pillar === 'all' ? all : all.filter(function (c) { return cr(c).p === S.pillar })).slice().sort(function (x, y) { return SEV_RANK[cr(x).s] - SEV_RANK[cr(y).s] })
    var out = '<p class="muted small">Repos checked against official best practices. Runtime rules join code with Dynatrace traffic, so a cache is recommended only where the measured read pattern proves it pays off.</p>'
    out += '<div class="filters"><button class="fchip' + (S.pillar === 'all' ? ' on' : '') + '" data-act="pillar" data-id="all">All <span class="num">' + all.length + '</span></button>' + VM.pillars.map(function (p) {
      var n = all.filter(function (c) { return cr(c).p === p[0] }).length
      return n ? '<button class="fchip' + (S.pillar === p[0] ? ' on' : '') + '" data-act="pillar" data-id="' + p[0] + '">' + p[1] + ' <span class="num">' + n + '</span></button>' : ''
    }).join('') + '</div>'
    out += list.slice(0, 60).map(function (c) {
      var r = cr(c)
      return '<article class="item' + (c.rule.indexOf('ARCH-CACHE') === 0 ? ' feature' : '') + '"><div class="item-top">' + sev(r.s) + '<b>' + esc(r.t) + '</b></div><div class="muted small">' + esc(pname(c.pid)) + ' · <code>' + esc(c.repo + '/' + c.file + (c.line ? ':' + c.line : '')) + '</code> · ' + pillarLabel(r.p) + '</div>' +
        '<pre class="evidence">' + esc(c.ev) + '</pre><p>' + esc(r.rec) + '</p>' + refs(r.refs) + '</article>'
    }).join('')
    return out
  }

  function cost() {
    var c = VM.scopes[S.pid].cost
    var max = Math.max.apply(null, c.totals.concat([1]))
    var out = '<div class="tiles"><div class="tile"><div class="tile-k">Spend this month</div><div class="tile-v">' + usd(c.cur) + '</div>' + chip((c.mom > 0 ? '+' : '') + c.mom + '% vs last month', c.mom > 5 ? 'tone-warn' : '') + '</div>' +
      '<div class="tile"><div class="tile-k">Savings identified</div><div class="tile-v t-good">' + usd(c.save) + '</div><span class="muted small">per month</span></div>' +
      '<div class="tile"><div class="tile-k">Cost of failed changes</div><div class="tile-v t-crit">' + usd(c.fail) + '</div><span class="muted small">downtime at tier rate + wasted CI</span></div>' +
      (c.per1k != null ? '<div class="tile"><div class="tile-k">Cost per 1k requests</div><div class="tile-v">$' + c.per1k.toFixed(3) + '</div><span class="muted small">spend over Dynatrace traffic</span></div>' : '') + '</div>'
    out += section('Monthly spend', '', '<div class="mbars">' + c.totals.map(function (v, i) {
      var m = MON[parseInt(c.months[i].slice(5), 10) - 1]
      return '<div class="mbar" title="' + m + ': ' + usdFull(v) + '"><b>' + usd(v) + '</b><i style="height:' + (v / max * 80) + '%"></i><b>' + m + '</b></div>'
    }).join('') + '</div>')
    var ms = c.svc.length ? c.svc[0][1] : 1
    out += section('Where it goes', 'this month', '<div class="funnel">' + c.svc.map(function (s) { return '<div class="funnel-row svc"><span class="funnel-k">' + esc(s[0]) + '</span>' + bar(s[1], ms) + '<span class="funnel-v num">' + usdFull(s[1]) + '</span></div>' }).join('') + '</div>')
    out += section('Actions', 'ranked by monthly saving', c.ins.map(function (i) {
      return '<article class="item"><div class="item-top">' + chip(i[0], i[0] === 'anomaly' ? 'tone-warn' : i[3] === 0 ? 'sev-high' : '') + '<b>' + esc(i[1]) + '</b><span class="push num t-good">' + (i[3] ? usdFull(i[3]) + '/mo' : '') + '</span></div><div class="muted small">' + esc(pname(i[5])) + ' · effort ' + i[4] + '</div><p>' + esc(i[2]) + '</p>' + refs(i[6]) + '</article>'
    }).join(''))
    return out + '<p class="muted small">Savings are estimates from published pricing ratios. Tune them to negotiated rates.</p>'
  }

  function practices() {
    var ids = S.pid === 'all' ? VM.products.map(function (p) { return p.id }) : [S.pid]
    ids.sort(function (x, y) { return VM.scores[y].o - VM.scores[x].o })
    return '<div class="scorecards">' + ids.map(function (id) {
      var s = VM.scores[id]
      return '<article class="score"><div class="item-top"><span class="grade big g-' + s.g + '">' + s.g + '</span><b>' + esc(pname(id)) + '</b><span class="push num muted">' + s.o + '/100</span></div>' +
        s.p.map(function (p) { return '<div class="funnel-row pillar"><span class="funnel-k">' + pillarLabel(p[0]) + '</span>' + bar(p[1], 100, p[1] >= 85 ? 'good' : p[1] >= 60 ? 'warn' : 'crit') + '<span class="funnel-v num">' + p[1] + '</span></div>' }).join('') +
        (S.pid !== 'all' ? '<ul class="factors">' + s.p.filter(function (p) { return p[2] }).map(function (p) { return '<li><b>' + pillarLabel(p[0]) + ':</b> ' + esc(p[2]) + '</li>' }).join('') + '</ul>' : '') + '</article>'
    }).join('') + '</div>'
  }

  // ---------- advisor: one best pattern per product ----------
  var EV_LABEL = { 'caused-failures': 'caused failures', 'runtime-confirmed': 'runtime confirmed', 'static': 'static finding' }
  function adviceDetail(x) {
    var f = x.f
    return '<dl class="ai-dl"><dt>Principle</dt><dd>' + esc(x.principle) + '</dd><dt>Problem</dt><dd>' + esc(x.problem) + '</dd><dt>Solution</dt><dd>' + esc(x.solution) + '</dd><dt>Trade-offs</dt><dd>' + esc(x.tradeoffs) + '</dd></dl>' +
      '<h4>Do this</h4><ol class="ai-actions">' + x.steps.map(function (st) { return '<li><span class="ai-action">' + esc(st) + '</span></li>' }).join('') + '</ol>' +
      '<h4>Why it ranks here</h4><div class="formula"><span><b>' + f.severity + '</b><i>severity</i></span><span>×</span><span><b>' + f.evidence + '</b><i>evidence</i></span><span>×</span><span><b>' + f.reach + '</b><i>reach</i></span><span>×</span><span><b>' + f.criticality + '</b><i>tier</i></span><span>+</span><span><b>' + f.savings + '</b><i>savings</i></span><span>=</span><span class="total"><b>' + x.score + '</b><i>priority</i></span></div>' +
      (x.gate ? '<p class="note">Security gate: an open critical exposure ranks first regardless of score.</p>' : '') +
      '<h4>Evidence it resolves</h4><ul class="factors">' + x.from.map(function (c) { return '<li>' + chip(c[0], c[0] === 'failure' ? 'sev-high' : c[0] === 'cost' ? 'tone-good' : '') + ' <code>' + esc(c[1]) + '</code> ' + esc(c[2]) + (c[3] > 1 ? ' <span class="muted">× ' + c[3] + '</span>' : '') + '</li>' }).join('') + '</ul>' + refs(x.refs)
  }
  function adviceCard(pid, x, big) {
    var key = pid + ':' + x.id, open = big || S.openA === key
    return '<article class="item advice' + (big ? ' feature' : '') + '"><button class="group-hit" data-act="advice" data-id="' + esc(key) + '"' + (big ? ' disabled' : '') + '><div class="item-top">' + (big ? '<span class="eyebrow">Do first</span>' : '') + chip(pillarLabel(x.p), '') + chip(EV_LABEL[x.ev], x.ev === 'caused-failures' ? 'sev-high' : x.ev === 'runtime-confirmed' ? 'tone-accent' : '') + (x.gate ? chip('security gate', 'sev-critical') : '') + '<span class="push num risk-score">' + x.score + '</span></div>' +
      '<div class="journey-title">' + esc(x.n) + '</div><div class="muted small">' + esc(x.why) + '</div></button>' + (open ? '<div class="finding">' + adviceDetail(x) + '</div>' : '') + '</article>'
  }
  function advisor() {
    var out = '<p class="muted small">One recommendation per product: the pattern from official design and reliability guidance that resolves the most risk, ranked by a published formula. Priority = Severity × Evidence × Reach × Tier + Savings. Evidence is 2.0 when it caused failures, 1.5 when runtime telemetry confirms it, 1.0 for static findings. An open critical security exposure always ranks first.</p>'
    if (S.pid === 'all') {
      out += VM.products.map(function (p) {
        var ad = VM.advice[p.id]
        return section(p.n, 'tier ' + p.tier, ad && ad.best ? adviceCard(p.id, ad.best, false) : '<p class="empty">No findings.</p>')
      }).join('')
    } else {
      var ad = VM.advice[S.pid]
      if (!ad || !ad.best) return out + '<p class="empty">No findings for this product.</p>'
      out += adviceCard(S.pid, ad.best, true)
      if (ad.next.length) out += section('Then', '', ad.next.map(function (x) { return adviceCard(S.pid, x, false) }).join(''))
    }
    out += section('Patterns this app is built on', '', '<ul class="factors">' + VM.selfPatterns.map(function (x) { return '<li><b>' + esc(x.n) + '</b>: ' + esc(x.why) + ' <span class="muted">· ' + esc(x.where) + '</span>' + refs(x.refs) + '</li>' }).join('') + '</ul>')
    return out
  }

  // ---------- map: the whole solution on one page; tools light up or go dead with their connections ----------
  var MAP_TOOLS = [
    ['servicenow', 'ServiceNow', 'Product identity (CMDB), changes, incidents', ['change'], ['classify', 'kb']],
    ['github', 'GitHub', 'Merges, CI, scans, code, Copilot', ['merged', 'build', 'test', 'scan', 'code'], ['gather', 'handoff']],
    ['argocd', 'Argo CD', 'Deployments and sync state', ['staging', 'prod'], ['gather']],
    ['kubernetes', 'Kubernetes', 'Pods, containers, nodes, events', ['staging', 'prod'], ['gather']],
    ['dynatrace', 'Dynatrace', 'Hub: problems, logs, traces, DORA', ['prod', 'verified'], ['gather', 'vendor']],
    ['aws', 'AWS', 'Cost, CloudTrail, EKS', ['cost'], ['gather']],
    ['azure', 'Azure', 'Cost, Activity Log, AKS', ['cost'], ['gather']],
    ['gcp', 'Google Cloud', 'Cost, Audit Logs, GKE', ['cost'], ['gather']],
  ]
  var MAP_STAGES = [['merged', 'Merged'], ['build', 'Build'], ['test', 'Test'], ['scan', 'Scan'], ['staging', 'Staging'], ['change', 'Change'], ['prod', 'Prod'], ['verified', 'Verified']]
  var MAP_INSIGHTS = [['code', 'Codebase and design advisor'], ['cost', 'Cost per product']]
  var MAP_AGENT = [['classify', 'Classify', 'rules'], ['gather', 'Gather evidence', 'MCP or Dynatrace'], ['kb', 'Search past incidents', 'RAG'], ['vendor', 'Ask vendor agents', 'Davis, Now Assist'], ['hypo', 'Hypothesize', 'Claude via LangChain'], ['verify', 'Verify', '6 checks'], ['rec', 'Recommend', 'guarded'], ['approve', 'You approve', 'human gate'], ['handoff', 'Copilot opens the PR', 'opt-in']]
  function demoCard() { return VM.mode === 'demo' }
  function cardOff() { return demoCard() ? (S.cardMode === 'live' ? MAP_TOOLS.map(function (t) { return t[0] }) : S.cardOffList.slice()) : [] }
  function toolState(id) {
    var it = null; for (var i = 0; i < VM.integrations.length; i++) if (VM.integrations[i].id === id) it = VM.integrations[i]
    if (demoCard() && cardOff().indexOf(id) >= 0) return 'dead'
    if (!it || it.tier === 'off') return 'dead'
    return it.tier === 'dummy' ? 'demo' : 'on'
  }
  var RANK = { dead: 0, demo: 1, on: 2 }, STATE_LABEL = { on: 'connected', demo: 'demo data', dead: 'off' }
  function bestOf(states) { var b = 'dead'; states.forEach(function (x) { if (RANK[x] > RANK[b]) b = x }); return b }
  function stateOfTarget(tid, col) {
    if (toolState('servicenow') === 'dead' && tid !== 'handoff') return 'dead' // no product identity: nothing joins
    var feeders = MAP_TOOLS.filter(function (t) { return t[col].indexOf(tid) >= 0 }).map(function (t) { return toolState(t[0]) })
    if (tid === 'hypo' || tid === 'verify' || tid === 'rec' || tid === 'approve') feeders.push(stateOfTarget('gather', 4))
    return feeders.length ? bestOf(feeders) : 'dead'
  }
  function node(cls, state, label, sub, hot, act, id) {
    return '<' + (act ? 'button data-act="' + act + '" data-id="' + id + '"' : 'div') + ' class="mnode ' + cls + ' st-' + state + (hot === false ? ' faded' : hot ? ' hot' : '') + '"><b>' + esc(label) + '</b>' + (sub ? '<span>' + esc(sub) + '</span>' : '') + '<i class="mdot"></i></' + (act ? 'button' : 'div') + '>'
  }
  function map() {
    var open = S.openTool, ot = null
    MAP_TOOLS.forEach(function (t) { if (t[0] === open) ot = t })
    var hot = function (tid, col) { return ot ? ot[col].indexOf(tid) >= 0 || (col === 4 && ['hypo', 'verify', 'rec', 'approve'].indexOf(tid) >= 0 && ot[4].indexOf('gather') >= 0) : null }
    var mode = demoCard() ? S.cardMode : (S.cfg ? S.cfg.settings.mode : null)
    var on = MAP_TOOLS.filter(function (t) { return toolState(t[0]) === 'on' }).length, demo = MAP_TOOLS.filter(function (t) { return toolState(t[0]) === 'demo' }).length
    var out = '<section class="section"><div class="section-head"><h2>How it works, end to end</h2><span class="muted small">' + on + ' connected · ' + demo + ' on demo data · ' + (MAP_TOOLS.length - on - demo) + ' off</span></div>' +
      '<p class="small">Tools feed the product journey. When something fails, the agent gathers evidence from the same tools, checks its own answer and waits for you. Tap a tool to see what it lights up.</p>' +
      '<div class="mode-row"><span class="muted small">Mode</span>' + ['demo', 'live'].map(function (m) { return '<button class="fchip' + (mode === m ? ' on' : '') + '" data-act="mode" data-id="' + m + '"' + (S.mapBusy ? ' disabled' : '') + '>' + (m === 'demo' ? 'Demo: dummy data for tools not connected' : 'Live: real connections only') + '</button>' }).join('') + (S.mapBusy ? '<span class="muted small">Updating…</span>' : '') + '</div>' +
      '<div class="legend small"><span><i class="mdot st-on"></i>connected</span><span><i class="mdot st-demo"></i>demo data</span><span><i class="mdot st-dead"></i>off or not connected</span></div>'
    out += '<div class="mcol"><h4>1 · Tools</h4><div class="mgrid tools">' + MAP_TOOLS.map(function (t) { return node('tool', toolState(t[0]), t[1], t[2] + ' · ' + STATE_LABEL[toolState(t[0])], open ? t[0] === open : null, 'tool', t[0]) }).join('') + '</div>'
    if (ot) {
      var st = toolState(ot[0]), sig = (VM.signals || []).filter(function (x) { return x.tool === ot[0] || (ot[0] === 'kubernetes' && x.tool === 'kubernetes') })
      out += '<div class="tool-panel"><b>' + esc(ot[1]) + '</b> · ' + esc(STATE_LABEL[st]) + ' · ' + sig.length + ' signals · feeds ' + esc(ot[3].concat(ot[4]).join(', ')) +
        '<div class="nav-row"><button class="btn" data-act="tool-toggle" data-id="' + ot[0] + '"' + (S.mapBusy ? ' disabled' : '') + '>' + (st === 'dead' && (demoCard() ? S.cardOffList.indexOf(ot[0]) >= 0 : S.cfg && S.cfg.settings.sourcesOff.indexOf(ot[0]) >= 0) ? 'Switch on' : 'Switch off') + '</button> <button class="btn" data-act="tab" data-id="integrations">Signals and connection details</button></div>' +
        (ot[0] === 'servicenow' ? '<p class="small muted">ServiceNow defines the products; switching it off makes the whole map dead.</p>' : '') + '</div>'
    }
    out += '</div><div class="marrow">↓</div><div class="mcol"><h4>2 · Product journey</h4><div class="mgrid stages">' + MAP_STAGES.map(function (x) { return node('stage', stateOfTarget(x[0], 3), x[1], '', hot(x[0], 3)) }).join('') + '</div>' +
      '<div class="mgrid insights">' + MAP_INSIGHTS.map(function (x) { return node('stage', stateOfTarget(x[0], 3), x[1], '', hot(x[0], 3)) }).join('') + '</div></div>'
    out += '<div class="marrow">↓ a failure</div><div class="mcol"><h4>3 · Agent (LangGraph)</h4><div class="mgrid agent">' + MAP_AGENT.map(function (x) { return node('step', x[0] === 'approve' ? 'on' : stateOfTarget(x[0], 4), x[1], x[2], hot(x[0], 4)) }).join('') + '</div>' +
      '<p class="small muted">Verification fails send it back for more evidence (at most twice). Nothing changes in any tool until you approve. Dynatrace is never written to.</p></div></section>'
    if (!demoCard() && S.cfg) out += mcpPanel()
    if (!demoCard() && !S.cfg) loadSettings()
    return out
  }
  function mcpPanel() {
    var m = S.cfg.mcp
    var out = '<section class="section"><div class="section-head"><h2>MCP servers</h2><span class="muted small">found in ' + m.files.length + ' config file(s)</span></div>' +
      '<p class="small">Read from your IDEs (Cursor, VS Code, Kiro, Claude Desktop, Windsurf) and mcp.servers.json, so MCP is configured once. <button class="btn" data-act="ide-toggle">' + (m.ideDiscovery ? 'Stop reading IDE configs' : 'Read IDE configs') + '</button></p>'
    out += m.servers.length ? '<ul class="factors">' + m.servers.map(function (x) { return '<li><b>' + esc(x.name) + '</b> ' + chip(x.on ? (x.connected ? 'connected · ' + x.tools + ' tools' : 'not connected') : 'off', x.on && x.connected ? 'tone-good' : x.on ? 'tone-warn' : '') + ' <span class="muted small">from ' + esc(x.from) + (x.error ? ' · ' + esc(x.error) : '') + '</span> <button class="btn" data-act="mcp-toggle" data-id="' + esc(x.name) + '">' + (x.on ? 'Switch off' : 'Switch on') + '</button></li>' }).join('') + '</ul>' : '<p class="muted small">No MCP servers found. Add them in your IDE or in mcp.servers.json.</p>'
    if (m.skipped.length) out += '<p class="small muted">Skipped: ' + esc(m.skipped.map(function (s) { return s.server + ' (' + s.app + '): ' + s.reason }).join('; ')) + '</p>'
    return out + '</section>'
  }
  function loadSettings() {
    if (S.cfgLoading) return
    S.cfgLoading = true
    fetch('api/integrations/settings').then(function (r) { return r.json() }).then(function (c) { S.cfg = c; S.cfgLoading = false; render() }, function () { S.cfgLoading = false })
  }
  function putSettings(patch) {
    S.mapBusy = true; render()
    fetch('api/integrations/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
      .then(function (r) { return r.json() }).then(function (c) { S.cfg = c; return fetchVm() }).then(function (vm) { VM = vm; NOW = Date.now() })
      .then(function () { S.mapBusy = false; render() }, function () { S.mapBusy = false; render() })
  }
  // the phone card has no server: switching recomputes the same view model in the page (agent.js)
  function rebuildCard() {
    S.mapBusy = true; render()
    var agentMeta = VM.agent
    agentLib().then(function (A) { VM = A.rebuild({ now: Date.parse(VM.at), off: cardOff() }); VM.agent = agentMeta; localAgentPromise = null; S.runs = {} })
      .then(function () { S.mapBusy = false; if (!VM.products.length) S.pid = 'all'; render() }, function (e) { S.mapBusy = false; render(); alertNote(e) })
  }
  function alertNote(e) { var n = document.createElement('p'); n.className = 'note'; n.textContent = 'Could not switch: ' + (e && e.message); app.prepend(n) }
  function setMode(m) {
    if (demoCard()) { S.cardMode = m; rebuildCard() } else putSettings({ mode: m })
  }
  function toggleTool(id) {
    if (demoCard()) {
      if (S.cardMode === 'live') S.cardMode = 'demo'
      var i = S.cardOffList.indexOf(id)
      if (i >= 0) S.cardOffList.splice(i, 1); else S.cardOffList.push(id)
      rebuildCard()
    } else {
      var off = (S.cfg ? S.cfg.settings.sourcesOff : []).slice(), j = off.indexOf(id)
      if (j >= 0) off.splice(j, 1); else off.push(id)
      putSettings({ sourcesOff: off })
    }
  }
  function toggleMcp(name) {
    var off = S.cfg.settings.mcpOff.slice(), j = off.indexOf(name)
    if (j >= 0) off.splice(j, 1); else off.push(name)
    putSettings({ mcpOff: off })
  }

  // ---------- integrations ----------
  var TIER_TONE = { live: 'tone-good', mcp: 'tone-accent', 'mcp-snapshot': 'tone-accent', dummy: 'tone-warn', off: 'sev-low' }
  var TIER_LABEL = { live: 'live API', mcp: 'live MCP', 'mcp-snapshot': 'MCP snapshot', dummy: 'dummy data', off: 'off', unknown: 'unknown' }
  function integrationTest(id) {
    S.itest[id] = { busy: true }
    render()
    fetch('api/integrations/' + id + '/test', { method: 'POST' }).then(function (r) { return r.json() }).then(function (j) { S.itest[id] = { res: j } }, function (e) { S.itest[id] = { err: e.message } }).then(render)
  }
  function integrationPaste(id) {
    var ta = document.getElementById('paste-' + id)
    var body = ta ? ta.value : ''
    S.paste[id] = { busy: true, text: body }
    render()
    fetch('api/ingest/' + id, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j }) })
      .then(function () { return fetch('api/vm').then(function (r) { return r.json() }) })
      .then(function (vm) { VM = vm; S.paste[id] = { msg: 'Accepted. ' + id + ' now runs on the snapshot.' } }, function (e) { S.paste[id] = { err: e.message, text: body } })
      .then(render)
  }
  function testResult(t) {
    if (!t) return ''
    if (t.busy) return '<p class="muted small">Testing…</p>'
    if (t.err) return '<p class="note">' + esc(t.err) + '</p>'
    var r = t.res, h = ''
    if (r.rest) h += '<li>' + (r.rest.ok ? '<span class="t-good">REST ok</span> · ' + r.rest.records + ' records' : '<span class="t-crit">REST failed</span> · ' + esc(r.rest.error)) + '</li>'
    if (r.mcp) h += '<li>' + (r.mcp.ok ? '<span class="t-good">MCP ok</span>' : '<span class="t-crit">MCP issue</span>') + ' · server <code>' + esc(r.mcp.server) + '</code>' + (r.mcp.toolsMissing && r.mcp.toolsMissing.length ? ' · missing tools: ' + esc(r.mcp.toolsMissing.join(', ')) : '') + (r.mcp.records != null ? ' · ' + r.mcp.records + ' records' : '') + (r.mcp.error ? ' · ' + esc(r.mcp.error) : '') + '</li>'
    if (r.hint) h += '<li class="muted">' + esc(r.hint) + '</li>'
    return '<ul class="factors">' + h + '</ul>'
  }
  function integrations() {
    var out = '<p class="muted small">Every screen reads data in these shapes. ' + (VM.mode === 'demo' ? 'This demo runs on dummy data built in each tool\'s own schema, so connecting a tool switches it to live data with no code change.' : 'Each tool resolves to the first available route: live API, live MCP, a pushed Cursor snapshot, or dummy data in the same schema.') + '</p>'
    out += VM.integrations.map(function (it) {
      var t = S.itest[it.id], pz = S.paste[it.id] || {}
      return '<article class="item integ"><div class="item-top"><b>' + esc(it.name) + '</b>' + chip(TIER_LABEL[it.tier] || it.tier, TIER_TONE[it.tier]) + (it.records != null ? '<span class="muted small">' + it.records.toLocaleString() + ' records</span>' : '') + '</div>' +
        '<div class="muted small">' + esc(it.role) + '</div>' + (it.error ? '<p class="note">' + esc(it.error) + '</p>' : '') +
        '<div class="two"><div><h4>Expected data</h4><ul class="factors">' + it.provides.map(function (x) { return '<li>' + esc(x) + '</li>' }).join('') + '</ul></div><div><h4>Feeds</h4><ul class="factors">' + it.feeds.map(function (x) { return '<li>' + esc(x) + '</li>' }).join('') + '</ul></div></div>' +
        '<h4>Connect</h4><ul class="factors">' + it.connect.map(function (c) { return '<li>' + chip(c.mode, c.mode === 'MCP' ? 'tone-accent' : '') + ' ' + esc(c.how) + '</li>' }).join('') + '<li>Env: <code>' + esc(it.env.join('  ')) + '</code></li>' + (it.mcpTools ? '<li>MCP tools used: <code>' + esc(it.mcpTools.join(', ')) + '</code></li>' : '') + '<li>Schema contract: <code>' + esc(it.schemaFile) + '</code></li></ul>' +
        signalsFor(it.id === 'kubernetes' ? ['kubernetes'] : [it.id]) +
        '<details><summary class="muted small">Sample record in ' + esc(it.name) + ' schema</summary><pre class="evidence">' + esc(it.sample) + '</pre></details>' +
        (SERVED ? '<div class="nav-row"><button class="btn" data-act="itest" data-id="' + it.id + '"' + (t && t.busy ? ' disabled' : '') + '>Test connection</button></div>' + testResult(t) +
          '<details' + (pz.err ? ' open' : '') + '><summary class="muted small">Paste MCP output (native schema)</summary><textarea id="paste-' + it.id + '" class="paste" rows="5" placeholder="Paste JSON shaped like ' + esc(it.schemaFile) + '">' + esc(pz.text || '') + '</textarea><div class="nav-row"><button class="btn" data-act="ipaste" data-id="' + it.id + '"' + (pz.busy ? ' disabled' : '') + '>Load snapshot</button></div>' +
          (pz.msg ? '<p class="small t-good">' + esc(pz.msg) + '</p>' : '') + (pz.err ? '<p class="note">' + esc(pz.err) + '</p>' : '') + '</details>' : '') +
        '</article>'
    }).join('')
    var other = (VM.signals || []).filter(function (x) { return x.tool === 'any' })
    if (other.length) out += '<article class="item integ"><div class="item-top"><b>Any other tool</b></div>' + signalsFor(['any']) + '</article>'
    return out
  }
  // signal catalogue: each signal, its paths in the order tried, and what uses it
  var VIA_TONE = { dynatrace: 'tone-good', mcp: 'tone-accent', rest: '', custom: 'tone-warn' }
  function signalsFor(tools) {
    var xs = (VM.signals || []).filter(function (x) { return tools.indexOf(x.tool) >= 0 })
    if (!xs.length) return ''
    return '<h4>Signals (' + xs.length + ')</h4><ul class="factors">' + xs.map(function (x) {
      return '<li><b>' + esc(x.n) + '</b>' + (x.k !== 'signal' ? ' ' + chip(x.k === 'action' ? 'action' : 'vendor agent', 'tone-warn') : '') + (x.s === 'built-optional' ? ' <span class="muted small">opt-in</span>' : x.s === 'catalogued' ? ' <span class="muted small">catalogued, not consumed yet</span>' : '') +
        '<br><span class="muted small">' + esc(x.f) + '</span><ol class="factors small">' + x.p.map(function (p) { return '<li>' + chip(p[0], VIA_TONE[p[0]]) + ' ' + esc(p[1]) + (p[2] ? ' <code>' + esc(p[2]) + '</code>' : '') + (p[3] ? ' <span class="muted small">listed, not called yet</span>' : '') + '</li>' }).join('') + '</ol>' +
        '<span class="muted small">Used by: ' + esc(x.u.join('; ')) + '</span></li>'
    }).join('') + '</ul>'
  }

  // ---------- shell ----------
  function render() {
    var p = prod(S.pid)
    var views = { map: map, overview: overview, journeys: journeys, fixes: fixes, prevent: prevent, advisor: advisor, code: code, cost: cost, practices: practices, integrations: integrations }
    document.getElementById('app').innerHTML =
      '<header class="top"><div class="wrap top-row"><div class="brand"><span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span><div><div class="brand-name">Product Journey</div><div class="brand-sub">' + (VM.mode === 'demo' ? 'Demo · dummy data in native source schemas' : 'Updated ' + ago(VM.at)) + '</div></div></div>' +
      '<label class="select"><span class="sr">Product</span><select id="product" data-act="select"><option value="all"' + (S.pid === 'all' ? ' selected' : '') + '>All products</option>' +
      VM.products.map(function (x) { return '<option value="' + x.id + '"' + (S.pid === x.id ? ' selected' : '') + '>' + esc(x.n) + ' · T' + x.tier + '</option>' }).join('') + '</select></label></div>' +
      '<nav class="wrap tabs">' + TABS.map(function (t) { return '<button class="tab' + (S.tab === t[0] ? ' on' : '') + '" data-act="tab" data-id="' + t[0] + '">' + t[1] + '</button>' }).join('') + '</nav></header>' +
      '<main class="wrap view">' + (p ? '<div class="product-bar"><b>' + esc(p.n) + '</b><span class="muted small">' + esc(p.o) + ' · ' + esc(p.t) + ' · tier ' + p.tier + ' · ' + esc(p.repos.join(', ')) + '</span></div>' : '') + (VM.products.length || S.tab === 'map' || S.tab === 'integrations' ? views[S.tab]() : '<p class="note">No products. ServiceNow (the CMDB) is off or not connected, so nothing can be joined to a product. Open <a href="#map" data-act="tab" data-id="map">Map</a> to switch it on, or switch to Demo.</p>') + '</main>'
  }

  var app = document.getElementById('app')
  app.addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('[data-act]') : null
    if (!el || el.tagName === 'SELECT') return
    var act = el.getAttribute('data-act'), id = el.getAttribute('data-id')
    if (act === 'tab') { S.tab = id; S.limit = 20; try { history.replaceState(null, '', '#' + id) } catch (x) { /* sandboxed */ } render(); window.scrollTo(0, 0) }
    else if (act === 'pid') setPid(id)
    else if (act === 'outcome') { S.outcome = id; S.limit = 20; render() }
    else if (act === 'pillar') { S.pillar = id; render() }
    else if (act === 'journey') { S.openJ[id] = !S.openJ[id]; render() }
    else if (act === 'group') { S.openG = S.openG === id ? '' : id; render() }
    else if (act === 'more') { S.limit += 20; render() }
    else if (act === 'advice') { S.openA = S.openA === id ? null : id; render() }
    else if (act === 'tool') { S.openTool = S.openTool === id ? null : id; render() }
    else if (act === 'tool-toggle') toggleTool(id)
    else if (act === 'mode') setMode(id)
    else if (act === 'mcp-toggle') toggleMcp(id)
    else if (act === 'ide-toggle') putSettings({ ideDiscovery: !(S.cfg && S.cfg.settings.ideDiscovery) })
    else if (act === 'itest') integrationTest(id)
    else if (act === 'ipaste') integrationPaste(id)
    else if (act === 'agent') startAgent(id)
    else if (act === 'agent-ok') decideAgent(id, 'approve')
    else if (act === 'agent-no') decideAgent(id, 'reject')
    else if (act === 'ai') runBrief(el.getAttribute('data-mode') + ':' + el.getAttribute('data-target'), el.getAttribute('data-mode'), el.getAttribute('data-target'))
  })
  app.addEventListener('change', function (e) { if (e.target.id === 'product') setPid(e.target.value) })
  function setPid(id) { S.pid = id; S.openG = null; try { localStorage.setItem('pjl.pid', id) } catch (x) { /* storage unavailable */ } render(); window.scrollTo(0, 0) }

  function start() {
    try { var saved = localStorage.getItem('pjl.pid'); if (saved && (saved === 'all' || prod(saved))) S.pid = saved } catch (e) { /* storage unavailable */ }
    try { render() } catch (err) { app.innerHTML = '<p class="boot">Could not render: ' + esc(err && err.message) + '</p>' }
  }
  function fetchVm() {
    return fetch('api/vm').then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json() })
  }
  if (VM) start()
  else {
    fetchVm().then(function (vm) { VM = vm; NOW = Date.now(); start() }, function (e) { app.innerHTML = '<p class="boot">Could not load data (' + esc(e.message) + '). Check that the server is running.</p>' })
    // served mode: refresh quietly every 5 minutes, keeping the current tab, product and open items
    setInterval(function () { fetchVm().then(function (vm) { VM = vm; NOW = Date.now(); render() }, function () { /* keep last good data */ }) }, 5 * 60000)
  }
})()
