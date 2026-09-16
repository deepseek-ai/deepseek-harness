// @vitest-environment jsdom
/** Content identity isolates terminal bindings across browser windows and Session scopes. */
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WebTerminalId } from '../src/types.ts'
import { TerminalBindings } from '../src/client/bindings.ts'

const session = 'session' as SessionId
const first = 'first' as WebTerminalId
const second = 'second' as WebTerminalId
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear() })

it('preserves other windows records through interleaved writes, closes and reloads', () => {
  const a = new TerminalBindings()
  const b = new TerminalBindings()
  expect(b.get(session, 'b')).toBeUndefined()
  a.set(session, 'a', first)
  b.set(session, 'b', second)
  a.delete(session, 'a')
  const reloaded = new TerminalBindings()
  expect(reloaded.get(session, 'a')).toBeUndefined()
  expect(reloaded.get(session, 'b')).toBe(second)
  expect(localStorage.length).toBe(1)
  expect(b.get(session, 'b')).toBe(second)
  a.set('session.with.dot' as SessionId, 'b', first)
  expect(new TerminalBindings().get(session, 'b')).toBe(second)
  expect(new TerminalBindings().get('session.with.dot' as SessionId, 'b')).toBe(first)
})

it.each(['{broken', 'null', '42', '"not/a/terminal"'])('rejects malformed saved identity %s', (value) => {
  const bindings = new TerminalBindings()
  bindings.set(session, 'content', first)
  const key = localStorage.key(0)!
  localStorage.setItem(key, value)
  expect(new TerminalBindings().get(session, 'content')).toBeUndefined()
})

it('keeps current-window values usable when storage is absent or inaccessible', () => {
  const a = new TerminalBindings()
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Storage blocked') })
  expect(a.get(session, 'missing')).toBeUndefined()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage full') })
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('Storage blocked') })
  a.set(session, 'a', first)
  expect(a.get(session, 'a')).toBe(first)
  a.delete(session, 'a')
  expect(a.get(session, 'a')).toBeUndefined()
  vi.stubGlobal('localStorage', undefined)
  a.set(session, 'b', second)
  expect(a.get(session, 'b')).toBe(second)
  a.clear()
  expect(a.get(session, 'b')).toBeUndefined()
  a.delete(session, 'b')
})
