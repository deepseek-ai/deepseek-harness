/** Explicit XLSX fuzz campaign with per-input worker deadlines and retained failure evidence. */
import { readFile, writeFile, mkdir, copyFile, mkdtemp, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { resolve, join, relative, isAbsolute } from 'node:path'
import { parseArgs } from 'node:util'
import { Worker } from 'node:worker_threads'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import type { ExcelPreview } from '../../src/client/excel/model.ts'

interface OracleCell { sheet: string; r: number; c: number; value: string | number | boolean | null; formula?: string }
interface Case {
  file: string
  writer: string
  features: string[]
  variant: string
  valid: boolean
  cells: OracleCell[]
  unsupportedFeatures: string[]
}
interface Manifest { seed: number; writers: Record<string, string>; cases: Case[]; generatorErrors: unknown[] }
type Reply = ({ ok: true; preview: ExcelPreview } | { ok: false; causes: string[] }) & { inputUnchanged?: boolean }
interface Outcome {
  file: string
  writer: string
  features: string[]
  variant: string
  valid: boolean
  status: string
  detail: string
  group: string
  elapsedMs: number
  opened: boolean
  sha256: string
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { only: { type: 'string' }, 'timeout-ms': { type: 'string', default: '10000' }, report: { type: 'string', default: 'results.json' }, 'baseline-ref': { type: 'string' } },
})
if (positionals.length !== 1) throw new Error('Usage: pnpm exec tsx packages/client/ui-sidebar-documentpreview/tests/fuzz/run.client.ts <corpus> [--only substring]')
const directory = resolve(positionals[0]!)
const deadlineMs = Number(values['timeout-ms'])
if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) throw new Error('timeout-ms must be a positive integer')
const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as Manifest
const cases = manifest.cases.filter(test => values.only === undefined || test.file.includes(values.only))
if (cases.length === 0) throw new Error('No cases selected')
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const artifactRoot = fileURLToPath(new URL('../../.artifacts/', import.meta.url))
let worker: Worker | undefined
let baselineDirectory: string | undefined
let source: string | undefined
let parserRef = head
if (values['baseline-ref'] !== undefined) {
  parserRef = execFileSync('git', ['rev-parse', '--verify', `${values['baseline-ref']}^{commit}`], { encoding: 'utf8' }).trim()
  const sourceRoot = new URL('../../src/client/excel/', import.meta.url).href
  const baseline = execFileSync('git', ['show', `${parserRef}:packages/client/ui-sidebar-documentpreview/src/client/excel/xlsx.ts`], { encoding: 'utf8' }).replaceAll("from './", `from '${sourceRoot}`)
  await mkdir(artifactRoot, { recursive: true })
  baselineDirectory = await mkdtemp(join(artifactRoot, 'excel-baseline-'))
  const path = join(baselineDirectory, 'xlsx.ts')
  await writeFile(path, baseline)
  source = pathToFileURL(path).href
}

async function parse(bytes: Uint8Array<ArrayBuffer>): Promise<Reply> {
  // Source conversion is the subject; a dedicated worker can be terminated even during synchronous ZIP/XML work.
  worker ??= new Worker(new URL('./excel-worker.client.ts', import.meta.url), { execArgv: ['--import', 'tsx/esm'], workerData: { source }, resourceLimits: { maxOldGenerationSizeMb: 256 } })
  const current = worker
  return new Promise((resolveReply) => {
    const cleanup = (): void => {
      clearTimeout(timer)
      current.off('message', message)
      current.off('error', error)
      current.off('exit', exit)
    }
    const message = (reply: Reply): void => { cleanup(); resolveReply(reply) }
    const error = (cause: Error): void => {
      cleanup()
      worker = undefined
      void current.terminate().then(() => { resolveReply({ ok: false, causes: [`WorkerError: ${cause.message}`] }) })
    }
    const exit = (code: number): void => {
      cleanup()
      worker = undefined
      resolveReply({ ok: false, causes: [`WorkerExit: ${code}`] })
    }
    const timer = setTimeout(() => {
      cleanup()
      worker = undefined
      void current.terminate().then(() => { resolveReply({ ok: false, causes: [`Timeout: ${deadlineMs}ms`] }) })
    }, deadlineMs)
    current.once('message', message)
    current.once('error', error)
    current.once('exit', exit)
    current.postMessage(bytes, [bytes.buffer])
  })
}

function inspect(test: Case, reply: Reply): Pick<Outcome, 'status' | 'detail' | 'group'> {
  if (reply.inputUnchanged === false) return { status: 'mutated-source', detail: 'Conversion mutated the borrowed input bytes', group: 'mutated-source' }
  if (!reply.ok) {
    const detail = reply.causes.join(' <- ')
    const controlled = /^ExcelPreviewError: (invalid|tooLarge|timeout|encoding)$/.test(reply.causes[0] ?? '')
    const status = test.valid ? 'rejected-valid' : controlled ? 'pass' : 'unclassified-error'
    const variant = test.variant.includes('sheet-prefix') ? 'sheet-prefix' : test.variant.includes('sheet-filename') ? 'sheet-filename' : test.variant.includes('relationship-dot') ? 'relationship-dot' : 'content'
    return { status, detail, group: `${status}:${variant}:${reply.causes.at(-1)}` }
  }
  if (!test.valid) return { status: 'accepted-corrupt', detail: 'Independent reader or ZIP relationship validation rejected this input; permissive acceptance requires inspection.', group: 'accepted-corrupt' }
  for (const expected of test.cells) {
    const sheet = reply.preview.sheets.find(sheet => sheet.name === expected.sheet)
    const cell = sheet?.celldata?.find(cell => cell.r === expected.r && cell.c === expected.c)?.v
    const actual = cell?.v ?? null
    const same = typeof expected.value === 'number' && typeof actual === 'number'
      ? Math.abs(actual - expected.value) <= Math.max(1, Math.abs(expected.value)) * 1e-12
      : actual === expected.value
    if (!same || (expected.formula !== undefined && expected.formula !== cell?.f)) {
      const detail = JSON.stringify({ expected, actual: cell ?? null })
      const category = expected.formula !== undefined ? 'formula-cache' : test.variant.startsWith('temporal') ? 'temporal' : 'value'
      return { status: 'value-mismatch', detail, group: `value-mismatch:${category}:${JSON.stringify(expected.value)}:${JSON.stringify(actual)}` }
    }
  }
  if (values['baseline-ref'] !== undefined) return { status: 'pass', detail: '', group: 'pass' }
  const actual = reply.preview.unsupportedFeatures
  if (new Set(actual).size !== actual.length || JSON.stringify(actual) !== JSON.stringify(test.unsupportedFeatures)) {
    const detail = JSON.stringify({ expected: test.unsupportedFeatures, actual })
    return { status: 'notice-mismatch', detail, group: `notice-mismatch:${detail}` }
  }
  return { status: 'pass', detail: '', group: 'pass' }
}

const outcomes: Outcome[] = []
try {
  for (const test of cases) {
    const bytes = new Uint8Array(await readFile(join(directory, test.file)))
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const start = performance.now()
    const reply = await parse(bytes)
    outcomes.push({
      file: test.file, writer: test.writer, features: test.features, variant: test.variant, valid: test.valid,
      ...inspect(test, reply), elapsedMs: Math.round(performance.now() - start), opened: reply.ok, sha256,
    })
    if (outcomes.length % 100 === 0) console.log(JSON.stringify({ completed: outcomes.length, total: cases.length, findings: outcomes.filter(item => item.status !== 'pass').length }))
  }
} finally {
  await worker?.terminate()
  if (baselineDirectory !== undefined) {
    const child = relative(artifactRoot, baselineDirectory)
    if (child === '' || child.startsWith('..') || isAbsolute(child)) throw new Error('Baseline cleanup escaped its artifact directory')
    await rm(baselineDirectory, { recursive: true })
  }
}

const counts: Record<string, number> = {}
const groups = new Map<string, Outcome[]>()
for (const outcome of outcomes) {
  counts[outcome.status] = (counts[outcome.status] ?? 0) + 1
  if (outcome.status !== 'pass') groups.set(outcome.group, [...(groups.get(outcome.group) ?? []), outcome])
}
const representatives: { group: string; count: number; example: string; detail: string }[] = []
await mkdir(join(directory, 'repros'), { recursive: true })
for (const [group, members] of groups) {
  const sorted = [...members].sort((a, b) => a.features.length - b.features.length
    || Number(a.variant.includes('random')) - Number(b.variant.includes('random')) || a.file.localeCompare(b.file))
  const first = sorted[0]!
  await copyFile(join(directory, first.file), join(directory, 'repros', first.file))
  representatives.push({ group, count: members.length, example: `repros/${first.file}`, detail: first.detail })
}
const report = {
  head, parserRef, seed: manifest.seed, writers: manifest.writers, selected: cases.length, counts,
  worktreeStatus: execFileSync('git', ['status', '--short'], { encoding: 'utf8' }).trim(),
  validOpened: outcomes.filter(outcome => outcome.valid && outcome.opened).length,
  validRejected: outcomes.filter(outcome => outcome.valid && !outcome.opened).length,
  generatorErrors: manifest.generatorErrors, representatives, outcomes,
}
await writeFile(join(directory, values.report), `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({ report: join(directory, values.report), head, selected: cases.length, counts, representatives }, null, 2))
if (outcomes.some(outcome => outcome.status !== 'pass' && outcome.status !== 'accepted-corrupt')) process.exitCode = 1
