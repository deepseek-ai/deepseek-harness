/**
 * The one-shot app's ordinary command-line provider over a real Loader tree:
 * the task, exact Session identity, and output mode become injected runner
 * config, while help and interactive usage errors leave the consumer pending.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { internals as cmdlineInternals, provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { afterEach, describe, expect, it } from 'vitest'
import {
  apply,
  HEADLESS_STARTUP_SERVICE,
  type HeadlessStartupValues,
} from '../src/startup.ts'
import { internals as startupInternals } from '../src/startup-internals.ts'

/** What one boot of the fixture tree observed. */
interface Observed {
  exits: number[]
  out: string
  err: string
  runnerConfig?: unknown
}

const disposers: (() => Promise<void>)[] = []

/** The real process facts captured before any test substitutes them. */
const originalInternals = { ...startupInternals }

/** Fixture tree roots, removed after their booted tree has been disposed. */
const tempDirs: string[] = []

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  cmdlineInternals.stdout = process.stdout
  cmdlineInternals.stderr = process.stderr
  startupInternals.stdinIsTty = () => process.stdin.isTTY
  startupInternals.stdout = process.stdout
})

/**
 * Mount the real provider over a runner stand-in.
 * @param args - the invocation's inner arguments.
 * @param options - process facts the provider reads.
 * @returns the resolved service value and observed runner/process effects.
 */
async function bootStartup(
  args: string[],
  options: { stdinIsTty?: boolean } = {},
): Promise<{ task: HeadlessStartupValues | undefined; observed: Observed }> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-headless-startup-'))
  tempDirs.push(dir)
  const observed: Observed = { exits: [], out: '', err: '' }
  writeFileSync(join(dir, 'row.mjs'), 'export function apply(_ctx, config) { globalThis.__headlessStartupObserved.runnerConfig = config }\n')
  // Loader imports through Node's resolver, so this fixture delegates to the
  // source-plane plugin already imported by the test.
  writeFileSync(join(dir, 'startup.mjs'), `
export const name = 'headless-startup'
export const inject = ['cmdlineArgs']
export const apply = ctx => globalThis.__headlessStartupApply(ctx)
`)
  const rowUrl = pathToFileURL(join(dir, 'row.mjs')).href
  writeFileSync(join(dir, 'cordis.yml'), [
    '- id: headless-runner',
    `  name: ${rowUrl}`,
    `  inject: [${HEADLESS_STARTUP_SERVICE}]`,
    '  config:',
    '    task: !!js ctx.headlessStartup.task',
    '    sessionId: !!js ctx.headlessStartup.sessionId',
    '    json: !!js ctx.headlessStartup.json',
    '- id: headless-startup',
    `  name: ${pathToFileURL(join(dir, 'startup.mjs')).href}`,
    '',
  ].join('\n'))
  const observing = { write: (chunk: string) => { observed.out += chunk; return true } }
  // Commander's own output keeps landing in `out` so existing assertions see
  // the full transcript, while `err` isolates what stderr actually carried.
  const observingErr = {
    write: (chunk: string) => {
      observed.out += chunk
      observed.err += chunk
      return true
    },
  }
  cmdlineInternals.stdout = observing
  cmdlineInternals.stderr = observingErr
  startupInternals.stdinIsTty = () => options.stdinIsTty === true
  startupInternals.stdout = observing
  const globals = globalThis as unknown as {
    __headlessStartupApply: typeof apply
    __headlessStartupObserved: Observed
  }
  globals.__headlessStartupApply = apply
  globals.__headlessStartupObserved = observed

  const ctx = new Context()
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  provideCmdline(ctx, { args, exit: code => void observed.exits.push(code) })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(dir, 'cordis.yml')).href } })
  await ctx.loader.await()
  disposers.push(async () => { await ctx.fiber.dispose() })
  return {
    task: ctx.get(HEADLESS_STARTUP_SERVICE) as HeadlessStartupValues | undefined,
    observed,
  }
}

describe('headless command-line provider', () => {
  it('joins the task positional into the runner config', async () => {
    const { task, observed } = await bootStartup(['run', 'the', 'tests'])
    expect(task).toEqual({ task: 'run the tests', sessionId: undefined, json: false })
    expect(observed.runnerConfig).toMatchObject({ task: 'run the tests', json: false })
    expect(observed.exits).toEqual([])
  })

  it('publishes the machine-readable output mode and the exact Session identity', async () => {
    const { task, observed } = await bootStartup(['--json', '--session-id', 'session-exact', 'do', 'it'])
    expect(task).toEqual({ task: 'do it', sessionId: 'session-exact', json: true })
    expect(observed.runnerConfig).toMatchObject({ task: 'do it', sessionId: 'session-exact', json: true })
  })

  it('keeps the stdin marker as the task so the runner reads the pipe', async () => {
    const { task } = await bootStartup(['-'], { stdinIsTty: false })
    expect(task).toEqual({ task: '-', sessionId: undefined, json: false })
  })

  it('defers an absent task to stdin when stdin is not a terminal', async () => {
    const { task, observed } = await bootStartup([], { stdinIsTty: false })
    expect(task).toEqual({ task: undefined, sessionId: undefined, json: false })
    expect(observed.runnerConfig).toMatchObject({ json: false })
  })

  it.each([{ args: [] as string[] }, { args: ['   '] }])('rejects an interactive invocation with no task ($args)', async ({ args }) => {
    const { task, observed } = await bootStartup(args, { stdinIsTty: true })
    expect(observed.out).toContain('a task is required')
    expect(task).toBeUndefined()
    expect(observed.runnerConfig).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })

  it('rejects an explicitly empty Session identity', async () => {
    const { task, observed } = await bootStartup(['--session-id', '', 'do', 'it'])
    expect(observed.out).toContain('--session-id requires a non-empty session id')
    expect(task).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })

  it('keeps the caller-provided exact Session identity verbatim', async () => {
    const { task } = await bootStartup(['--session-id', ' session-x ', 'do', 'it'])
    expect(task).toEqual({ task: 'do it', sessionId: ' session-x ', json: false })
  })

  it('rejects a lone stdin marker mixed with other task words', async () => {
    const { task, observed } = await bootStartup(['-', 'do', 'it'])
    expect(observed.out).toContain('`-` must be the only task argument')
    expect(task).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })

  it('writes the JSON error event for a --json usage error', async () => {
    const { task, observed } = await bootStartup(['--json'], { stdinIsTty: true })
    const first = JSON.parse(observed.out.trim().split('\n')[0] ?? '{}') as { type: string; message: string }
    expect(first).toEqual({
      type: 'error',
      message: 'a task is required, for example: dsh --profile headless "run the tests"',
    })
    expect(task).toBeUndefined()
    expect(observed.err).toBe('')
    expect(observed.exits).toEqual([1])
  })

  it('writes the JSON error event for an empty Session identity in --json mode', async () => {
    const { observed } = await bootStartup(['--json', '--session-id', '', 'do', 'it'])
    const first = JSON.parse(observed.out.trim().split('\n')[0] ?? '{}') as { type: string; message: string }
    expect(first.type).toBe('error')
    expect(first.message).toContain('--session-id requires a non-empty session id')
    expect(observed.err).toBe('')
    expect(observed.exits).toEqual([1])
  })

  it('writes the JSON error event for a commander grammar rejection in --json mode', async () => {
    const { task, observed } = await bootStartup(['--json', '--bogus', 'do', 'it'])
    const first = JSON.parse(observed.out.trim().split('\n')[0] ?? '{}') as { type: string; message: string }
    expect(first).toEqual({ type: 'error', message: "unknown option '--bogus'" })
    expect(task).toBeUndefined()
    expect(observed.err).toBe('')
    expect(observed.exits).toEqual([1])
  })

  it('does not install the JSON error override for a --json option value', async () => {
    const { observed } = await bootStartup(['--session-id', '--json'], { stdinIsTty: true })
    expect(observed.out).toContain('a task is required')
    expect(observed.out).not.toContain('"type":"error"')
    expect(observed.exits).toEqual([1])
  })

  it('does not install the JSON error override for a --json positional after --', async () => {
    const { task, observed } = await bootStartup(['--', '--json'], { stdinIsTty: false })
    expect(task).toEqual({ task: '--json', sessionId: undefined, json: false })
    expect(observed.out).not.toContain('"type":"error"')
  })

  it('rejects a blank positional task instead of reading stdin', async () => {
    const { task, observed } = await bootStartup(['   '], { stdinIsTty: false })
    expect(observed.out).toContain('a task is required')
    expect(task).toBeUndefined()
    expect(observed.runnerConfig).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })

  it('reports the real process stdin terminal state by default', () => {
    const original = Object.getOwnPropertyDescriptor(process, 'stdin')
    Object.defineProperty(process, 'stdin', { value: { isTTY: true }, configurable: true })
    try {
      expect(originalInternals.stdinIsTty()).toBe(true)
    } finally {
      if (original !== undefined) Object.defineProperty(process, 'stdin', original)
    }
  })

  it('fails loud without the launcher command line and exit request', () => {
    expect(() => { apply(new Context()) }).toThrow('the launcher must provide ctx.cmdlineArgs and ctx.appExit')
  })

  it('prints its own help and leaves the runner pending', async () => {
    const { task, observed } = await bootStartup(['--help'])
    expect(observed.out).toContain('dsh --profile headless')
    expect(observed.out).toContain('the answer goes to stdout and diagnostics to stderr')
    expect(observed.out).toContain('--session-id')
    expect(task).toBeUndefined()
    expect(observed.runnerConfig).toBeUndefined()
    expect(observed.exits).toEqual([0])
  })
})
