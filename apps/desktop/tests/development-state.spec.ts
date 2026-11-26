/** Development launches choose the Harness home and keep browser data where repository cleaning does not remove it. */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { prepareDevelopmentState } from '../scripts/development-state.ts'

const filesystem = vi.hoisted(() => ({ crossDevice: false, failCopy: false }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      // A staged copy already sits on the default home's volume.
      if (filesystem.crossDevice && !String(args[0]).includes('-move-')) {
        throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' })
      }
      actual.renameSync(...args)
    },
    cpSync: (...args: Parameters<typeof actual.cpSync>) => {
      actual.cpSync(...args)
      if (filesystem.failCopy) throw new Error('copy interrupted')
    },
  }
})

function fixture(): { root: string; home: string; local: string; userData: string } {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const root = mkdtempSync(join(tmpdir(), 'dsh-development-state-'))
  onTestFinished(() => {
    Object.assign(filesystem, { crossDevice: false, failCopy: false })
    vi.restoreAllMocks()
    rmSync(root, { recursive: true, force: true })
  })
  return { root, home: join(root, 'dsh-home'), local: join(root, '.desktop-dev', 'home'), userData: join(root, '.desktop-dev', 'electron-user-data') }
}

function write(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

it('uses the default home without local development state', () => {
  const { root, home, userData } = fixture()
  expect(prepareDevelopmentState(root, {}, home)).toEqual({ home, userData })
  expect(existsSync(home)).toBe(false)
})

it('uses the default home when the local development home is empty', () => {
  const { root, home, local } = fixture()
  mkdirSync(local, { recursive: true })
  write(join(home, 'settings.json'), 'home')
  expect(prepareDevelopmentState(root, {}, home).home).toBe(home)
  expect(existsSync(local)).toBe(true)
})

it.each([['missing', false], ['empty', true]])('moves the local development home into a %s default home', (_name, create) => {
  const { root, home, local } = fixture()
  write(join(local, 'sessions', 'a.jsonl'), 'session')
  if (create) mkdirSync(home)

  expect(prepareDevelopmentState(root, {}, home).home).toBe(home)
  expect(readFileSync(join(home, 'sessions', 'a.jsonl'), 'utf8')).toBe('session')
  expect(existsSync(local)).toBe(false)
})

it('keeps using the local development home when both homes hold data', () => {
  const { root, home, local } = fixture()
  write(join(local, 'sessions', 'a.jsonl'), 'local session')
  write(join(home, 'sessions', 'b.jsonl'), 'home session')

  expect(prepareDevelopmentState(root, {}, home).home).toBe(local)
  expect(readFileSync(join(local, 'sessions', 'a.jsonl'), 'utf8')).toBe('local session')
  expect(existsSync(join(home, 'sessions', 'a.jsonl'))).toBe(false)
})

it('moves state from .desktop-build through the local development home', () => {
  const { root, home, userData } = fixture()
  const legacy = join(root, '.desktop-build', 'development')
  write(join(legacy, 'home', 'session.jsonl'), 'session')
  mkdirSync(join(legacy, 'electron-user-data'))

  expect(prepareDevelopmentState(root, {}, home)).toEqual({ home, userData })
  expect(readFileSync(join(home, 'session.jsonl'), 'utf8')).toBe('session')
  expect(existsSync(userData)).toBe(true)
  expect(existsSync(join(legacy, 'home'))).toBe(false)
})

it('uses explicit locations without moving any state', () => {
  const { root, home, local } = fixture()
  write(join(local, 'settings.json'), 'local')
  mkdirSync(join(root, '.desktop-build', 'development', 'electron-user-data'), { recursive: true })

  expect(prepareDevelopmentState(root, { DSH_HOME: join(root, 'h'), DSH_DESKTOP_USER_DATA_DIR: join(root, 'u') }, home))
    .toEqual({ home: join(root, 'h'), userData: join(root, 'u') })
  expect(existsSync(join(local, 'settings.json'))).toBe(true)
  expect(existsSync(home)).toBe(false)
  expect(existsSync(join(root, '.desktop-build', 'development', 'electron-user-data'))).toBe(true)
})

it.skipIf(process.platform === 'win32')('does not move state that a running Harness Dev still owns', () => {
  const { root, home, local, userData } = fixture()
  write(join(local, 'settings.json'), 'local')
  mkdirSync(userData, { recursive: true })
  symlinkSync(`host-${String(process.pid)}`, join(userData, 'SingletonLock'))

  expect(() => prepareDevelopmentState(root, {}, home)).toThrow('a running Harness Dev still uses')
  expect(existsSync(join(local, 'settings.json'))).toBe(true)
  expect(existsSync(home)).toBe(false)
})

it.each(['', '  '])('treats DSH_HOME %j as unset', (value) => {
  const { root, home, local } = fixture()
  write(join(local, 'settings.json'), 'local')
  expect(prepareDevelopmentState(root, { DSH_HOME: value }, home).home).toBe(home)
  expect(readFileSync(join(home, 'settings.json'), 'utf8')).toBe('local')
})

it('expands ~ in an explicit DSH_HOME', () => {
  const { root, home } = fixture()
  expect(prepareDevelopmentState(root, { DSH_HOME: '~/dsh-development-home' }, home).home)
    .toBe(join(homedir(), 'dsh-development-home'))
})

it.skipIf(process.platform === 'win32')('keeps the local home when the default home is a symbolic link', () => {
  const { root, home, local } = fixture()
  write(join(local, 'settings.json'), 'local')
  symlinkSync(join(root, 'unmounted'), home)

  expect(prepareDevelopmentState(root, {}, home).home).toBe(local)
  expect(lstatSync(home).isSymbolicLink()).toBe(true)
  expect(existsSync(join(local, 'settings.json'))).toBe(true)
})

it('copies across volumes into a sibling before the default home appears', () => {
  const { root, home, local } = fixture()
  write(join(local, 'sessions', 'a.jsonl'), 'session')
  Object.assign(filesystem, { crossDevice: true, failCopy: true })

  expect(() => prepareDevelopmentState(root, {}, home)).toThrow('copy interrupted')
  expect(existsSync(home)).toBe(false)
  expect(readdirSync(root).filter(name => name.includes('-move-'))).toEqual([])
  expect(readFileSync(join(local, 'sessions', 'a.jsonl'), 'utf8')).toBe('session')

  filesystem.failCopy = false
  expect(prepareDevelopmentState(root, {}, home).home).toBe(home)
  expect(readFileSync(join(home, 'sessions', 'a.jsonl'), 'utf8')).toBe('session')
  expect(existsSync(local)).toBe(false)
})

it.skipIf(process.platform === 'win32')('checks the default browser data even when another one is selected', () => {
  const { root, home, local, userData } = fixture()
  write(join(local, 'settings.json'), 'local')
  mkdirSync(userData, { recursive: true })
  symlinkSync(`host-${String(process.pid)}`, join(userData, 'SingletonLock'))

  expect(() => prepareDevelopmentState(root, { DSH_DESKTOP_USER_DATA_DIR: join(root, 'u') }, home))
    .toThrow('a running Harness Dev still uses')
  expect(existsSync(join(local, 'settings.json'))).toBe(true)
})
