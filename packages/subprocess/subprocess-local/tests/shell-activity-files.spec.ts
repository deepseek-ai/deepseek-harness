/** Private activity records reject stale input evidence and incomplete observations. */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { prepareShellActivity, ShellActivity } from '../src/shell-activity.ts'

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, writeFileSync: vi.fn(fs.writeFileSync) }
})
const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.mocked(writeFileSync).mockReset() })
const spec: SubprocessTerminalSpawnSpec = { argv: ['/bin/zsh', '-i'], cwd: '/', rows: 24, cols: 80, terminalType: 'xterm-256color', graceMs: 100, shellActivity: true }

it('accepts only fresh complete records from the original shell and advances revisions on input', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-activity-record-'))
  cleanups.push(() => { rmSync(directory, { recursive: true, force: true }) })
  const activity = new ShellActivity(directory, [], {})
  expect(activity.inspect(123).state).toBe('unknown')
  const state = join(directory, 'state')
  writeFileSync(state, '123:1:idle\n')
  const idle = activity.inspect(123)
  expect(idle.state).toBe('idle')
  expect(activity.inspect(123)).toEqual(idle)
  activity.invalidate()
  expect(activity.inspect(123)).toEqual({ state: 'unknown', revision: idle.revision + 1 })
  writeFileSync(state, '123:2:busy')
  expect(activity.inspect(123).state).toBe('busy')
  writeFileSync(state, '999:2:idle\n')
  expect(activity.inspect(123).state).toBe('unknown')
  writeFileSync(state, '123:3:id')
  expect(activity.inspect(123).state).toBe('unknown')
  activity.dispose()
  expect(activity.inspect(123).state).toBe('unknown')
})

it('leaves unsupported executables, platforms, and custom launch arguments untouched', () => {
  expect(prepareShellActivity({ ...spec, argv: ['/bin/fish', '-i'] }, {}, 'darwin')).toBeUndefined()
  expect(prepareShellActivity({ ...spec, argv: ['/bin/zsh', '-l'] }, {}, 'darwin')).toBeUndefined()
  expect(prepareShellActivity({ ...spec, argv: ['/bin/zsh', '-l', '-i'] }, {}, 'darwin')).toBeUndefined()
  expect(prepareShellActivity({ ...spec, shellActivity: false }, {}, 'darwin')).toBeUndefined()
  expect(prepareShellActivity(spec, {}, 'win32')).toBeUndefined()
})

it('supports an unset original ZDOTDIR and removes private files on disposal', () => {
  const activity = prepareShellActivity(spec, {}, 'darwin')!
  cleanups.push(() => { activity.dispose() })
  expect(activity.env.ZDOTDIR).toBeDefined()
  expect(existsSync(activity.env.ZDOTDIR!)).toBe(true)
  activity.dispose()
  expect(existsSync(activity.env.ZDOTDIR!)).toBe(false)
})

it('restores a quoted original ZDOTDIR before sourcing user startup files', () => {
  const env = Object.freeze({ ZDOTDIR: "/shell config/user's $settings", OTHER: 'preserved' })
  const activity = prepareShellActivity(spec, env, 'linux')!
  cleanups.push(() => { activity.dispose() })
  const directory = activity.env.ZDOTDIR!
  expect(directory).not.toBe(env.ZDOTDIR)
  expect(activity.env).toEqual({ ...env, ZDOTDIR: directory })
  expect(activity.argv).toEqual(spec.argv)
  expect(readFileSync(join(directory, '.zshenv'), 'utf8').split('\n').slice(0, 2)).toEqual([
    "ZDOTDIR='/shell config/user'\\''s $settings'",
    '[[ ! -r ${ZDOTDIR:-$HOME}/.zshenv ]] || builtin source "${ZDOTDIR:-$HOME}/.zshenv"',
  ])
  activity.dispose()
  expect(existsSync(directory)).toBe(false)
})

it('removes the allocated private directory when writing its startup file fails', () => {
  let directory: string | undefined
  vi.mocked(writeFileSync).mockImplementationOnce((path) => {
    directory = dirname(String(path))
    throw new Error('disk unavailable')
  })
  expect(() => prepareShellActivity(spec, {}, 'darwin')).toThrow('disk unavailable')
  expect(directory).toBeDefined()
  expect(existsSync(directory!)).toBe(false)
})
