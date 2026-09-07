/**
 * REAL-composition tier: explicit feedback through the shipped headless
 * Loader profile with a mock model and real shell. The collector observes
 * only the redacted authorized prefix; the canonical log keeps every event.
 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const driver = fileURLToPath(new URL(
  './fixtures/driver.ts',
  import.meta.url,
))
const configPath = fileURLToPath(new URL(
  './fixtures/telemetry.patch.yml',
  import.meta.url,
))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

const FIXTURE_SECRET = 'sk-e2efixture1234567890'
const FIXTURE_PLACEHOLDER = '[E2E-REDACTED]'

interface OtlpLogRecord {
  attributes?: { key: string; value: Record<string, unknown> }[]
  body?: unknown
}

interface OtlpCapture {
  resourceLogs: {
    scopeLogs: {
      scope: { name: string }
      logRecords: OtlpLogRecord[]
    }[]
  }[]
}

interface FixtureOutput {
  captures: OtlpCapture[]
  logContent: string
}

async function jsonlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const paths = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return jsonlFiles(path)
    return entry.isFile() && entry.name.endsWith('.jsonl') ? [path] : []
  }))
  return paths.flat()
}

async function readFixtureOutput(cwd: string): Promise<FixtureOutput> {
  const captures = JSON.parse(await readFile(join(cwd, 'otlp-captures.json'), 'utf8')) as OtlpCapture[]
  const logs = await jsonlFiles(join(cwd, '.sessions'))
  expect(logs).toHaveLength(1)
  return { captures, logContent: await readFile(logs[0] as string, 'utf8') }
}

function allRecords(captures: OtlpCapture[]) {
  return captures.flatMap(capture => capture.resourceLogs.flatMap(resource =>
    resource.scopeLogs.flatMap(scoped => scoped.logRecords.map(record => ({ scope: scoped.scope.name, record })))))
}

function eventTypes(captures: OtlpCapture[]): string[] {
  return allRecords(captures).flatMap(({ record }) =>
    record.attributes?.flatMap(attribute =>
      attribute.key === 'event.type' && typeof attribute.value['stringValue'] === 'string'
        ? [attribute.value['stringValue']]
        : []) ?? [])
}

describe('session-telemetry-otel through the production headless profile', () => {
  it('rejects FULL before any session can be uploaded', async () => {
    const { stdout, stderr } = await runLoaderSmoke({
      label: 'session-telemetry-otel rejected FULL loader smoke',
      tempDirPrefix: 'telemetry-otel-full-e2e-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      tsconfigPath: repoTsconfig,
      env: { DSH_TELEMETRY_E2E_MODE: 'FULL' },
      expectedExitCode: 1,
    })
    expect(stdout + stderr).toContain('FULL')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('exports the redacted feedback-authorized prefix while the canonical log keeps the secret', async () => {
    let output!: FixtureOutput
    const { stderr } = await runLoaderSmoke({
      label: 'session-telemetry-otel loader smoke',
      tempDirPrefix: 'telemetry-otel-e2e-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      tsconfigPath: repoTsconfig,
      inspect: async (cwd) => { output = await readFixtureOutput(cwd) },
    })
    expect(stderr).not.toContain('UNHANDLED')

    const records = allRecords(output.captures)
    expect(records.length).toBeGreaterThan(0)

    const types = eventTypes(output.captures)
    for (const expected of ['turn/start', 'user/message', 'tool/call', 'tool/result', 'assistant/message', 'turn/end']) {
      expect(types, expected).toContain(expected)
    }
    const canonicalEvents = output.logContent.trim().split('\n')
      .map(line => JSON.parse(line) as { type: string; seq?: number })
      .filter(event => event.seq !== undefined)
    const feedbackIndex = canonicalEvents.findIndex(event => event.type === 'feedback/record')
    expect(feedbackIndex).toBeGreaterThanOrEqual(0)
    expect(types).toEqual(canonicalEvents.slice(0, feedbackIndex + 1).map(event => event.type))
    expect(types.at(-1)).toBe('feedback/record')
    expect(records.some(({ scope }) => scope.endsWith('/ops'))).toBe(false)

    const wire = JSON.stringify(output.captures)
    expect(wire).not.toContain(FIXTURE_SECRET)
    expect(wire).toContain(FIXTURE_PLACEHOLDER)
    expect(wire).toContain('prove telemetry with key')
    expect(wire).toContain('fixture feedback')
    expect(wire).not.toContain('post-feedback private suffix')
    expect(wire).not.toContain('private operational error')
    expect(wire).not.toContain('telemetry.op')

    expect(output.logContent).toContain('post-feedback private suffix')
    expect(output.logContent).toContain(FIXTURE_SECRET)
    expect(output.logContent).not.toContain(FIXTURE_PLACEHOLDER)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('never captures ordinary turns or shutdown without new feedback', async () => {
    let output!: FixtureOutput
    const { stderr } = await runLoaderSmoke({
      label: 'session-telemetry-otel no-feedback loader smoke',
      tempDirPrefix: 'telemetry-otel-no-feedback-e2e-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      tsconfigPath: repoTsconfig,
      env: { DSH_TELEMETRY_E2E_FEEDBACK: 'none' },
      inspect: async (cwd) => { output = await readFixtureOutput(cwd) },
    })
    expect(stderr).not.toContain('UNHANDLED')
    expect(output.captures).toEqual([])
    expect(output.logContent).toContain('prove telemetry with key')
    expect(output.logContent).toContain('post-feedback private suffix')
    expect(output.logContent).not.toContain('feedback/record')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('keeps disabled feedback local and prints the stable warning', async () => {
    let output!: FixtureOutput
    const { stdout } = await runLoaderSmoke({
      label: 'session-telemetry-otel disabled loader smoke',
      tempDirPrefix: 'telemetry-otel-disabled-e2e-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      tsconfigPath: repoTsconfig,
      env: { DSH_TELEMETRY_E2E_MODE: 'DISABLED' },
      inspect: async (cwd) => { output = await readFixtureOutput(cwd) },
    })

    expect(output.captures).toEqual([])
    expect(output.logContent).toContain('fixture feedback')
    expect(stdout.match(/OpenTelemetry session upload is DISABLED; this feedback is not uploaded through OpenTelemetry/)?.[0])
      .toMatchInlineSnapshot('"OpenTelemetry session upload is DISABLED; this feedback is not uploaded through OpenTelemetry"')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
