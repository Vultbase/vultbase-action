/**
 * Vultbase GitHub Action
 * Submits smart contracts for security analysis and blocks the PR on findings.
 *
 * Flow:
 *  1. Load .vultbase.yml config (if present)
 *  2. Collect contract files matching the glob, applying exclude patterns
 *  3. POST /api/ci/submit → get jobId
 *  4. Poll GET /api/ci/result/:jobId until completed/failed or timeout
 *  5. Set outputs; exit 1 if passed === false
 */

import * as core   from '@actions/core'
import * as glob   from '@actions/glob'
import * as fs     from 'fs'
import * as path   from 'path'
import * as yaml   from 'js-yaml'
import FormData    from 'form-data'

// ── Config file schema ───────────────────────────────────────────────────────
interface VultbaseConfig {
  protocol?:  string
  language?:  'solidity' | 'rust'
  chain?:     string
  audit?: {
    include?:  string[]   // glob patterns for source contracts
    exclude?:  string[]   // patterns to strip (test/, mock/, interface/)
  }
  ci?: {
    on_pr?: {
      mode?:        'pr' | 'full'
      fail_on?:     'critical' | 'high' | 'medium'
      challenges?:  string[]
    }
    on_push_main?: {
      mode?:        'pr' | 'full'
      fail_on?:     'critical' | 'high' | 'medium'
      challenges?:  string[]
    }
  }
}

function loadConfig(workspace: string, configPath: string): VultbaseConfig {
  if (!configPath) return {}
  const full = path.isAbsolute(configPath) ? configPath : path.join(workspace, configPath)
  if (!fs.existsSync(full)) return {}
  try {
    const raw = yaml.load(fs.readFileSync(full, 'utf8')) as VultbaseConfig
    core.info(`[Vultbase] Loaded config from ${configPath}`)
    return raw || {}
  } catch (e: any) {
    core.warning(`[Vultbase] Could not parse ${configPath}: ${e.message}`)
    return {}
  }
}

// ── Runtime config resolution ────────────────────────────────────────────────
// Detect whether we're running in a PR context or a push-to-main context.
const EVENT_NAME     = process.env.GITHUB_EVENT_NAME || ''
const REF            = process.env.GITHUB_REF || ''
const IS_PR          = EVENT_NAME === 'pull_request' || EVENT_NAME === 'pull_request_target'
const IS_MAIN_PUSH   = EVENT_NAME === 'push' && (REF === 'refs/heads/main' || REF === 'refs/heads/master')
const WORKSPACE      = process.env.GITHUB_WORKSPACE || process.cwd()

const CONFIG_FILE_PATH = core.getInput('config-file')
const vbConfig         = loadConfig(WORKSPACE, CONFIG_FILE_PATH)

// Pick the right ci sub-section based on event
const ciContext = IS_PR ? vbConfig.ci?.on_pr : (IS_MAIN_PUSH ? vbConfig.ci?.on_push_main : undefined)

// Resolve each value: explicit Action input > config file > defaults
const BASE_URL      = core.getInput('vultbase-url').replace(/\/$/, '')
const API_KEY       = core.getInput('api-key')
const PROTOCOL_NAME = core.getInput('protocol-name') || vbConfig.protocol || 'Unknown Protocol'
const LANGUAGE      = core.getInput('language')      || vbConfig.language  || 'solidity'
const TARGET_CHAIN  = core.getInput('target-chain')  || vbConfig.chain     || 'ethereum'
const FAIL_ON       = core.getInput('fail-on')       || ciContext?.fail_on  || 'critical'
const MODE          = core.getInput('mode')          || ciContext?.mode     || (IS_MAIN_PUSH ? 'full' : 'pr')
const SELECTED_RAW  = core.getInput('selected-challenges')
const SELECTED      = SELECTED_RAW && SELECTED_RAW !== '[]'
  ? SELECTED_RAW
  : ciContext?.challenges?.length ? JSON.stringify(ciContext.challenges) : '[]'

// Glob settings
const CONTRACTS_GLOB_INPUT = core.getInput('contracts')
const CONTRACTS_GLOB = CONTRACTS_GLOB_INPUT
  || (vbConfig.audit?.include?.join('\n') ?? '**/*.sol')
const EXCLUDE_PATTERNS: string[] = [
  ...(vbConfig.audit?.exclude ?? []),
  // Always strip obvious non-production files
  '**/*.test.sol', '**/*.spec.sol', '**/*.t.sol',
  '**/*.test.rs',  '**/*.spec.rs',
  '**/test/**', '**/tests/**', '**/mock/**', '**/mocks/**',
  '**/interface/**', '**/interfaces/**',
  '**/node_modules/**', '**/lib/**',
]

const POLL_INTERVAL  = parseInt(core.getInput('poll-interval')) * 1000
const TIMEOUT_MS     = parseInt(core.getInput('timeout')) * 60 * 1000

async function postJson(url: string, body: any): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`POST ${url} → ${res.status}: ${await res.text()}`)
  return res.json()
}

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  })
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}: ${await res.text()}`)
  return res.json()
}

async function submitContracts(files: string[]): Promise<string> {
  const form = new FormData()
  form.append('protocolName', PROTOCOL_NAME)
  form.append('language', LANGUAGE)
  form.append('targetChain', TARGET_CHAIN)
  form.append('mode', MODE)
  form.append('failOn', FAIL_ON)
  form.append('selectedChallenges', SELECTED || '[]')
  const eventLabel = IS_PR ? 'PR' : (IS_MAIN_PUSH ? 'push→main' : EVENT_NAME || 'manual')
  form.append('description', `GitHub Actions [${eventLabel}] — ${process.env.GITHUB_REPOSITORY} @ ${process.env.GITHUB_SHA?.slice(0, 8)}`)

  for (const file of files) {
    form.append('contracts', fs.createReadStream(file), path.basename(file))
  }

  const res = await fetch(`${BASE_URL}/api/ci/submit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, ...form.getHeaders() },
    body: form as any,
  })
  if (!res.ok) throw new Error(`Submit failed (${res.status}): ${await res.text()}`)
  const data = await res.json()
  return data.jobId
}

async function poll(jobId: string): Promise<any> {
  const deadline = Date.now() + TIMEOUT_MS
  while (Date.now() < deadline) {
    const result = await getJson(`${BASE_URL}/api/ci/result/${jobId}`)
    core.info(`[Vultbase] Status: ${result.status} | Critical: ${result.summary?.critical ?? '?'} | High: ${result.summary?.high ?? '?'}`)

    if (result.status === 'completed' || result.status === 'failed') return result
    await new Promise(r => setTimeout(r, POLL_INTERVAL))
  }
  throw new Error(`Timed out after ${core.getInput('timeout')} minutes waiting for analysis`)
}

function shouldExclude(filePath: string): boolean {
  const rel = filePath.replace(WORKSPACE, '').replace(/\\/g, '/')
  return EXCLUDE_PATTERNS.some(pat => {
    // Simple glob match: support ** and *
    const re = '(?:^|/)' + pat
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // escape regex chars (not * or ?)
      .replace(/\*\*/g, '.+')
      .replace(/\*/g, '[^/]+')
    return new RegExp(re).test(rel)
  })
}

async function run() {
  try {
    core.info(`[Vultbase] Mode: ${MODE} | Event: ${EVENT_NAME || 'unknown'} | Fail-on: ${FAIL_ON}`)

    // 1. Find contract files and apply exclusions
    const globber  = await glob.create(CONTRACTS_GLOB)
    const allFiles = await globber.glob()
    const files    = allFiles.filter((f: string) => !shouldExclude(f))

    if (!files.length) {
      const excluded = allFiles.length - files.length
      core.setFailed(
        excluded
          ? `All ${allFiles.length} matched file(s) were excluded by exclude patterns. ` +
            `Review .vultbase.yml audit.exclude or check your contracts glob.`
          : `No files matched pattern: ${CONTRACTS_GLOB}`
      )
      return
    }
    const excluded = allFiles.length - files.length
    if (excluded > 0) core.info(`[Vultbase] Excluded ${excluded} file(s) matching exclude patterns`)
    core.info(`[Vultbase] Found ${files.length} contract file(s): ${files.map((f: string) => path.basename(f)).join(', ')}`)


    // 2. Submit
    core.info('[Vultbase] Submitting contracts for analysis...')
    const jobId = await submitContracts(files)
    core.info(`[Vultbase] Job ID: ${jobId}`)
    core.setOutput('job-id', jobId)

    // 3. Poll
    core.info(`[Vultbase] Polling for results (fail-on: ${FAIL_ON}, timeout: ${core.getInput('timeout')}m)...`)
    const result = await poll(jobId)

    // 4. Outputs
    core.setOutput('passed',          String(result.passed))
    core.setOutput('critical-count',  String(result.summary?.critical ?? 0))
    core.setOutput('high-count',      String(result.summary?.high ?? 0))
    core.setOutput('total-findings',  String(result.summary?.total ?? 0))
    core.setOutput('report-url',      result.reportUrl ?? '')

    // 5. Summary
    await core.summary
      .addHeading('Vultbase Security Audit', 2)
      .addTable([
        [{ data: 'Severity', header: true }, { data: 'Count', header: true }],
        ['🔴 Critical', String(result.summary?.critical ?? 0)],
        ['🟠 High',     String(result.summary?.high ?? 0)],
        ['🟡 Medium',   String(result.summary?.medium ?? 0)],
        ['🔵 Low',      String(result.summary?.low ?? 0)],
      ])
      .addLink('View Full Report', result.reportUrl ?? BASE_URL)
      .write()

    if (result.passed === false) {
      core.setFailed(
        `Vultbase audit failed — found ${result.summary?.critical ?? 0} critical, ` +
        `${result.summary?.high ?? 0} high findings (fail-on: ${FAIL_ON}). ` +
        `See full report: ${result.reportUrl}`
      )
    } else {
      core.info(`✅ Vultbase audit passed. Report: ${result.reportUrl}`)
    }
  } catch (err: any) {
    core.setFailed(`Vultbase Action error: ${err.message}`)
  }
}

run()
