/** Real interactive shells preserve startup files and distinguish prompts from running jobs. */
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessTerminalActivity } from '@deepseek-ai/dsh-subprocess'
import { afterEach, describe, expect, it } from 'vitest'
import LocalSubprocessRuntime from '../src/index.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

/** Prompt every startup file in this spec prints; its repeats count the prompts a shell reached. */
const PROMPT_MARKER = 'READY>'

async function shell(path: string, rc = '', envFile = '') {
  const home = await mkdtemp(join(tmpdir(), 'dsh-shell-activity-test-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  await writeFile(join(home, '.zshenv'), envFile)
  await writeFile(join(home, '.zshrc'), `PROMPT='${PROMPT_MARKER} '\n${rc}\n`)
  await writeFile(join(home, '.bashrc'), `PS1='${PROMPT_MARKER} '\n${rc}\n`)
  const ctx = new Context()
  cleanups.push(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(LocalSubprocessRuntime)
  const handle = await ctx.subprocess.spawnTerminal({ argv: [path, '-i'], cwd: home, env: { HOME: home, ZDOTDIR: home }, rows: 24, cols: 80, terminalType: 'xterm-256color', graceMs: 200, shellActivity: true })
  cleanups.push(() => handle.terminate())
  let output = ''
  handle.output.on('data', (data: Buffer) => { output += data.toString('utf8') })
  await expect.poll(() => output).toContain(PROMPT_MARKER)
  const prompts = (): number => output.split(PROMPT_MARKER).length - 1
  return { handle, home, prompts, output: () => output, activity: async () => (await handle.inspectActivity()).state }
}

type Shell = Awaited<ReturnType<typeof shell>>

/** Collapse repeated samples and bound how many groups the message can carry. */
function summarizeSamples(samples: readonly string[]): string {
  const groups: Array<{ sample: string; count: number }> = []
  for (const sample of samples) {
    const last = groups.at(-1)
    if (last?.sample === sample) last.count += 1
    else groups.push({ sample, count: 1 })
  }
  const rendered = groups.map(group => group.count === 1 ? group.sample : `${group.sample} x${group.count}`)
  return rendered.length <= 8 ? rendered.join(' ') : `${rendered.slice(0, 6).join(' ')} … ${rendered.slice(-2).join(' ')}`
}

/**
 * Poll one activity expectation. A timeout names the sampled `state:revision` values, how many
 * prompts the shell printed while it waited, and keeps the original failure as cause. A prompt
 * in the window shows the shell returned to one; a count of zero shows none appeared while the
 * message waited. The samples are a bounded summary: the state record and the process
 * observation behind `unknown` are not exposed here.
 */
async function expectActivity(h: Shell, expected: SubprocessTerminalActivity['state'], label?: string): Promise<void> {
  const observed: string[] = []
  const promptsBefore = h.prompts()
  try {
    await expect.poll(async () => {
      const activity = await h.handle.inspectActivity()
      observed.push(`${activity.state}:${activity.revision}`)
      return activity.state
    }).toBe(expected)
  } catch (cause) {
    const prompts = h.prompts() - promptsBefore
    const samples = observed.length === 0 ? 'no sample' : summarizeSamples(observed)
    throw new Error(`${label === undefined ? 'terminal activity' : `terminal activity for "${label}"`} reported state:revision ${samples} with ${prompts} further prompt${prompts === 1 ? '' : 's'} instead of reaching ${expected}`, { cause })
  }
}

describe.skipIf(process.platform === 'win32' || !existsSync('/bin/zsh'))('Zsh terminal activity', () => {
  it('keeps silent foreground work, builtin loops, read, and background jobs busy until a new prompt is idle', async () => {
    const h = await shell('/bin/zsh')
    await expectActivity(h, 'idle')
    for (const command of ['sleep 600', 'while :; do :; done', 'read answer', 'sleep 600 &']) {
      await h.handle.write(`${command}\r`)
      await expectActivity(h, 'busy', command)
      await h.handle.write(command.endsWith('&') ? 'kill %1\r' : '\x03')
      await expectActivity(h, 'idle', command)
    }
  })

  it('does not confuse vared or multiline editing with a top-level empty prompt', async () => {
    const h = await shell('/bin/zsh')
    await expectActivity(h, 'idle')
    await h.handle.write('value=abc; vared value\r')
    await expectActivity(h, 'busy')
    await h.handle.write('\x03')
    await expectActivity(h, 'idle')
    await h.handle.write('if true; then\r')
    await expectActivity(h, 'busy')
    await h.handle.write('fi\r')
    await expectActivity(h, 'idle')
    await h.handle.write('partial')
    expect(await h.activity()).toBe('unknown')
  })

  it('preserves startup options and ZDOTDIR and supports noclobber status updates', async () => {
    const h = await shell('/bin/zsh', 'setopt noclobber\nprint RC-LOADED', 'print ENV-LOADED')
    expect(h.output()).toContain('ENV-LOADED')
    expect(h.output()).toContain('RC-LOADED')
    await expectActivity(h, 'idle')
    await h.handle.write('print -r -- "DIRECTORY:$ZDOTDIR"\r')
    await expect.poll(() => h.output()).toContain(`DIRECTORY:${h.home}`)
    await expectActivity(h, 'idle')
    expect(h.output()).not.toContain('file exists')
  })

  it('protects a stopped job even after the shell returns to the prompt', async () => {
    const h = await shell('/bin/zsh')
    await expectActivity(h, 'idle')
    await h.handle.write('sleep 600\r')
    await expectActivity(h, 'busy')
    await h.handle.write('\x1a')
    await expect.poll(() => h.output()).toContain('suspended')
    expect(await h.activity()).toBe('busy')
    await h.handle.write('kill -KILL %1\r')
    await expectActivity(h, 'idle')
  })

  it('refuses idle evidence when custom signal traps may run without terminal input', async () => {
    const h = await shell('/bin/zsh', "trap ':' USR1")
    expect(await h.activity()).toBe('unknown')
    await h.handle.write('trap - USR1\r')
    await expectActivity(h, 'idle')
  })

  it('leaves disabled startup files disabled and restores ZDOTDIR immediately', async () => {
    const h = await shell('/bin/zsh', 'print UNEXPECTED-RC', `unsetopt rcs\nPROMPT='${PROMPT_MARKER} '`)
    expect(h.output()).not.toContain('UNEXPECTED-RC')
    await h.handle.write('print -r -- "DIRECTORY:$ZDOTDIR"\r')
    await expect.poll(() => h.output()).toContain(`DIRECTORY:${h.home}`)
  })
})

describe.skipIf(process.platform === 'win32' || !existsSync('/bin/bash'))('Bash terminal activity', () => {
  it('preserves scalar prompt hooks and uses unknown on shells without PS0', async () => {
    const h = await shell('bash', "PROMPT_COMMAND='printf HOOK; # user comment'\nset -C")
    expect(h.output()).toContain('HOOK')
    await h.handle.write('printf "VERSION:%s\\n" "$BASH_VERSION"\r')
    await expect.poll(() => h.output()).toContain('VERSION:')
    await expect.poll(() => /VERSION:\d+\.\d+/u.test(h.output())).toBe(true)
    const version = /VERSION:(\d+)\.(\d+)/u.exec(h.output())
    const supported = Number(version?.[1]) > 4 || Number(version?.[1]) === 4 && Number(version?.[2]) >= 4
    if (!supported) { expect(await h.activity()).toBe('unknown'); return }
    await expectActivity(h, 'idle')
    for (const command of ['sleep 600', 'while :; do :; done', 'read answer']) {
      await h.handle.write(`${command}\r`)
      await expectActivity(h, 'busy', command)
      await h.handle.write('\x03')
      await expectActivity(h, 'idle', command)
    }
    expect(h.output()).not.toContain('syntax error')
    expect(h.output()).not.toContain('file exists')
  })
})
