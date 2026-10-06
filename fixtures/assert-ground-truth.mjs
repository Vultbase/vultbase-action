/**
 * Regression assertions for CI integration (Node 20+).
 * Env: JOB_ID, VULTBASE_API_KEY, optional VULTBASE_URL (default www.vultbase.com)
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const spec = JSON.parse(fs.readFileSync(path.join(__dirname, 'GROUND_TRUTH.json'), 'utf8'))

const jobId = process.env.JOB_ID
const apiKey = process.env.VULTBASE_API_KEY
const base = (process.env.VULTBASE_URL || 'https://www.vultbase.com').replace(/\/$/, '')

const SEVERITY_RANK = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 }

function severityAtLeast(actual, min) {
  const a = SEVERITY_RANK[actual?.toUpperCase()]
  const m = SEVERITY_RANK[min?.toUpperCase()]
  if (a === undefined || m === undefined) return false
  return a <= m
}

function titleMatch(finding, includes) {
  return (finding.title || '').toLowerCase().includes(includes.toLowerCase())
}

if (!jobId || !apiKey) {
  console.error('JOB_ID and VULTBASE_API_KEY are required')
  process.exit(1)
}

const res = await fetch(`${base}/api/ci/result/${jobId}`, {
  headers: { Authorization: `Bearer ${apiKey}` },
})
if (!res.ok) {
  console.error(`GET /api/ci/result/${jobId} → ${res.status}: ${await res.text()}`)
  process.exit(1)
}

const data = await res.json()
if (data.status !== 'completed') {
  console.error(`Job status is "${data.status}", expected completed`)
  process.exit(1)
}

const findings = data.findings || []
console.log(`Findings (${findings.length}):`, findings.map(f => `${f.title} [${f.severity}]`).join('; ') || '(none)')

if (findings.length < (spec.minTotalFindings || 1)) {
  console.error(`Expected at least ${spec.minTotalFindings} finding(s), got ${findings.length}`)
  process.exit(1)
}

for (const rule of spec.required || []) {
  const hit = findings.find(f => {
    if (!titleMatch(f, rule.titleIncludes)) return false
    if (rule.minSeverity && !severityAtLeast(f.severity, rule.minSeverity)) return false
    if (rule.category && f.category && f.category.toUpperCase() !== rule.category.toUpperCase()) {
      return false
    }
    return true
  })
  if (!hit) {
    console.error(`Missing required finding: title~="${rule.titleIncludes}" category=${rule.category || 'any'}`)
    process.exit(1)
  }
  console.log(`OK required: ${hit.title} (${hit.severity}, category=${hit.category || 'n/a'})`)
}

for (const rule of spec.recommended || []) {
  const hit = findings.find(
    f =>
      titleMatch(f, rule.titleIncludes) &&
      (!rule.category || (f.category || '').toUpperCase() === rule.category.toUpperCase())
  )
  if (hit) {
    console.log(`OK recommended: ${hit.title}`)
  } else {
    console.warn(`WARN recommended missing: ${rule.titleIncludes} (non-fatal)`)
  }
}

console.log('Ground-truth regression checks passed.')
