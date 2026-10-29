import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { boot, StartupError } from '@deepseek-ai/dsh-app-boot'
import { formatFatalDiagnostic, MAX_FATAL_DIAGNOSTIC_CHARS } from '../src/fatal-diagnostic.ts'
import { renderCrashReport } from '../../desktop/src/crash-report.ts'

it.each([
  ['import', 'throw new Error("qualification-import-failure")'],
  ['initialize', 'export function apply() { throw new Error("qualification-initialize-failure", { cause: new Error("qualification-root-cause") }) }'],
])('retains real plugin %s failure evidence in the Desktop report after Loader disposal', async (stage, source) => {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-plugin-failure-'))
  onTestFinished(async () => { await rm(directory, { recursive: true, force: true }) })
  await writeFile(join(directory, 'failure.mjs'), source + '\n')
  const config = join(directory, 'cordis.yml')
  await writeFile(config, '- id: agent-loop\n  name: ./failure.mjs\n')
  const failure: unknown = await boot('diagnostic-test', config).then(async (ctx) => {
    await ctx.fiber.dispose()
    throw new Error('Expected fixture plugin to fail startup')
  }, (error: unknown) => error)
  expect(failure).toBeInstanceOf(StartupError)
  const diagnostic = formatFatalDiagnostic(failure)
  const report = renderCrashReport({ source: 'host', phase: 'startup', error: failure,
    hostDiagnostic: diagnostic, rendererConsole: [], operationHistoryPlanned: true,
    time: new Date('2026-10-19T00:00:00Z'),
    app: { name: 'qualification', version: 'test', platform: 'win32', arch: 'x64', electron: 'test', node: process.version, locale: 'zh-CN' },
  })
  expect(report).toContain(`qualification-${stage}-failure`)
  expect(report).toContain('./failure.mjs')
  expect(report).toContain('--- startup composition ---')
  if (stage === 'initialize') expect(report).toContain('qualification-root-cause')
})

it('includes non-enumerable startup entries without copying arbitrary startup logger arguments', () => {
  const error = new StartupError('required plugin did not activate', [{
    id: 'agent-loop', module: '@deepseek-ai/dsh-agent-loop', required: true, fiberState: undefined,
    outcome: { kind: 'pending', missing: ['agents', 'sessions'] },
  }])
  error.startup = { configurationPath: '/profile/cordis.yml', messages: [{
    ts: 1, name: 'plugin', type: 'warn', args: ['private-plugin-output'],
  }] }
  const report = formatFatalDiagnostic(new Error('Host startup failed', { cause: error }))
  expect(report).toContain('--- startup entries ---')
  expect(report).toContain('@deepseek-ai/dsh-agent-loop')
  expect(report).toContain("missing: [ 'agents', 'sessions' ]")
  expect(report).toContain('Configuration file: /profile/cordis.yml')
  expect(report).not.toContain('private-plugin-output')
})

it('marks truncation within the complete IPC budget and preserves Unicode', () => {
  const error = new Error('😀'.repeat(MAX_FATAL_DIAGNOSTIC_CHARS))
  const report = formatFatalDiagnostic(error)
  expect(report.length).toBeLessThanOrEqual(MAX_FATAL_DIAGNOSTIC_CHARS)
  expect(report).toContain('Host diagnostic truncated at 65536 characters')
  expect(report.isWellFormed()).toBe(true)
})

it('keeps missing-service evidence ahead of a truncated plugin inventory', () => {
  const error = new StartupError('failure '.repeat(2000), [{
    id: 'waiting-entry', module: './waiting.mjs', required: true, fiberState: undefined,
    outcome: { kind: 'pending', missing: ['agents'] },
  }])
  error.startup = { configurationPath: '/profile/critical-cordis.yml', messages: [] }
  error.composition = {
    services: [{ consumer: 'agent-loop', service: 'agents', providers: [] }],
    plugins: Array.from({ length: 256 }, (_, index) => ({
      id: `plugin-${index}`, module: 'long-package-name'.repeat(30), version: '1.0.0',
      state: 'disabled', source: '/profile/cordis.yml', missing: [],
    })),
    omittedPlugins: 3, omittedServices: 2,
  }
  const report = formatFatalDiagnostic(error)
  expect(report).toContain('original error truncated at 8192 characters')
  expect(report).toContain('Configuration file: /profile/critical-cordis.yml')
  expect(report).toContain('waiting-entry')
  expect(report).toContain('"service":"agents","providers":[]')
  expect(report).toContain('Omitted plugin rows: 3; omitted missing-service observations: 2.')
  expect(report).toContain('"source":"/profile/cordis.yml"')
  expect(report).toContain('Host diagnostic truncated at 65536 characters')
  expect(report.length).toBeLessThanOrEqual(MAX_FATAL_DIAGNOSTIC_CHARS)
})

it('terminates traversal through cyclic and aggregate causes', () => {
  const error = new AggregateError([], 'cycle')
  error.errors.push(error)
  error.cause = error
  expect(formatFatalDiagnostic(error)).toContain('cycle')
})

it.each(['many entries', 'long stack'])('retains composition evidence after %s', (scenario) => {
  const failure = new Error('startup failure')
  failure.stack = 'x'.repeat(70000)
  const error = new StartupError('startup failed', scenario === 'long stack'
    ? [{ id: 'failed', module: './failed.mjs', required: true, fiberState: undefined, outcome: { kind: 'failed', error: failure } }]
    : Array.from({ length: 256 }, (_, index) => ({ id: `pending-${index}`, module: 'module'.repeat(60), required: true, fiberState: undefined, outcome: { kind: 'pending' as const, missing: ['agents'] } })))
  error.startup = { configurationPath: '/profile/cordis.yml', messages: [] }
  error.composition = { plugins: [{ id: 'provider', module: 'example', version: '1.0.0', state: 'active', source: '/profile/cordis.yml', missing: [] }], services: [{ consumer: 'consumer', service: 'agents', providers: [] }], omittedPlugins: 0, omittedServices: 0 }
  const report = formatFatalDiagnostic(error)
  expect(report).toContain('Configuration file: /profile/cordis.yml')
  expect(report).toContain('startup entries truncated')
  expect(report).toContain('"service":"agents"')
  expect(report).toContain('"version":"1.0.0"')
  expect(report.length).toBeLessThanOrEqual(65536)
})
