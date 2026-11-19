/** Development launches keep Harness state where repository cleaning does not remove it. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { prepareDevelopmentState } from '../scripts/development-state.ts'

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-development-state-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  return root
}

it('moves state from .desktop-build into the default development state directory', () => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  onTestFinished(() => { vi.restoreAllMocks() })
  const root = fixture()
  const legacy = join(root, '.desktop-build', 'development')
  mkdirSync(join(legacy, 'home'), { recursive: true })
  mkdirSync(join(legacy, 'electron-user-data'))
  writeFileSync(join(legacy, 'home', 'session.jsonl'), 'session')

  const state = prepareDevelopmentState(root, {})

  expect(state).toEqual({ home: join(root, '.desktop-dev', 'home'), userData: join(root, '.desktop-dev', 'electron-user-data') })
  expect(readFileSync(join(state.home, 'session.jsonl'), 'utf8')).toBe('session')
  expect(existsSync(state.userData)).toBe(true)
  expect(existsSync(join(legacy, 'home'))).toBe(false)
})

it('keeps existing default state and leaves legacy state in place', () => {
  const root = fixture()
  mkdirSync(join(root, '.desktop-dev', 'home'), { recursive: true })
  mkdirSync(join(root, '.desktop-build', 'development', 'home'), { recursive: true })

  expect(prepareDevelopmentState(root, {}).home).toBe(join(root, '.desktop-dev', 'home'))
  expect(existsSync(join(root, '.desktop-build', 'development', 'home'))).toBe(true)
})

it('moves only the default directory that is missing', () => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  onTestFinished(() => { vi.restoreAllMocks() })
  const root = fixture()
  const legacy = join(root, '.desktop-build', 'development')
  mkdirSync(join(legacy, 'home'), { recursive: true })
  mkdirSync(join(legacy, 'electron-user-data'))

  const state = prepareDevelopmentState(root, { DSH_HOME: join(root, 'h') })

  expect(state).toEqual({ home: join(root, 'h'), userData: join(root, '.desktop-dev', 'electron-user-data') })
  expect(existsSync(state.userData)).toBe(true)
  expect(existsSync(join(legacy, 'home'))).toBe(true)
})

it('uses explicit locations without moving legacy state', () => {
  const root = fixture()
  mkdirSync(join(root, '.desktop-build', 'development', 'home'), { recursive: true })

  expect(prepareDevelopmentState(root, { DSH_HOME: join(root, 'h'), DSH_DESKTOP_USER_DATA_DIR: join(root, 'u') }))
    .toEqual({ home: join(root, 'h'), userData: join(root, 'u') })
  expect(existsSync(join(root, '.desktop-build', 'development', 'home'))).toBe(true)
  expect(existsSync(join(root, '.desktop-dev'))).toBe(false)
})

it.skipIf(process.platform === 'win32')('does not move state that a running Harness Dev still owns', () => {
  const root = fixture()
  const legacy = join(root, '.desktop-build', 'development')
  mkdirSync(join(legacy, 'home'), { recursive: true })
  mkdirSync(join(legacy, 'electron-user-data'))
  symlinkSync(`host-${String(process.pid)}`, join(legacy, 'electron-user-data', 'SingletonLock'))

  expect(() => prepareDevelopmentState(root, {})).toThrow('a running Harness Dev still uses')
  expect(existsSync(join(legacy, 'home'))).toBe(true)
  expect(existsSync(join(root, '.desktop-dev'))).toBe(false)
})
