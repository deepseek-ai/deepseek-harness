// @vitest-environment jsdom
/** Task tab bindings recover the task one restored tab page last showed. */
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ScheduleId } from '@deepseek-ai/dsh-schedule/client'
import { TaskTabBindings, type TaskTabPage, type TaskTabTarget } from '../src/client/task-tab-bindings.ts'

const session = 'session.with.dot' as SessionId
const otherSession = 'session-other' as SessionId

/**
 * One task tab page as the persisted layout restores it.
 * @param id - the layout record's own id.
 * @returns the page identity its binding is keyed by.
 */
function page(id: string): TaskTabPage {
  return { id, kind: 'scheduleTask', contentId: 'sidebar://scheduleTask' }
}

/**
 * One task target.
 * @param id - the task's own id.
 * @returns the target a navigation names.
 */
function target(id: string): TaskTabTarget {
  return { sessionId: session, id: id as ScheduleId }
}

/** The single storage key this Session's bindings were written under. */
function storedKey(): string {
  return localStorage.key(0)!
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
})

it('recovers the task a tab page last showed after a new window loads', () => {
  const bindings = new TaskTabBindings()
  expect(bindings.read(session, page('tab1'))).toBeUndefined()
  bindings.write(session, page('tab1'), target('task-1'))
  expect(new TaskTabBindings().read(session, page('tab1'))).toEqual(target('task-1'))
})

it('keeps one entry per tab page and one document per Session', () => {
  const bindings = new TaskTabBindings()
  bindings.write(session, page('tab1'), target('task-1'))
  bindings.write(session, page('tab2'), target('task-2'))
  bindings.write(otherSession, page('tab1'), target('task-3'))
  const reloaded = new TaskTabBindings()
  expect(reloaded.read(session, page('tab1'))).toEqual(target('task-1'))
  expect(reloaded.read(session, page('tab2'))).toEqual(target('task-2'))
  expect(reloaded.read(otherSession, page('tab1'))).toEqual(target('task-3'))
  expect(localStorage.length).toBe(2)
})

it('keeps only the last task one page showed', () => {
  const bindings = new TaskTabBindings()
  bindings.write(session, page('tab1'), target('task-1'))
  bindings.write(session, page('tab1'), target('task-2'))
  expect(new TaskTabBindings().read(session, page('tab1'))).toEqual(target('task-2'))
  expect(localStorage.length).toBe(1)
})

it('stores only the page identity and the task target', () => {
  const bindings = new TaskTabBindings()
  bindings.write(session, page('tab1'), target('task-1'))
  expect(localStorage.getItem(storedKey())).toBe(JSON.stringify({
    tab1: {
      kind: 'scheduleTask', contentId: 'sidebar://scheduleTask',
      sessionId: session, id: 'task-1',
    },
  }))
})

const reusedPage: readonly (readonly [string, TaskTabPage])[] = [
  ['kind', { ...page('tab1'), kind: 'guide' }],
  ['contentId', { ...page('tab1'), contentId: 'sidebar://guide' }],
]

it.each(reusedPage)('drops an entry saved for another %s under a reused tab id', (_field, reader) => {
  const bindings = new TaskTabBindings()
  bindings.write(session, page('tab1'), target('task-1'))
  // The read is pure: a mismatched entry is ignored, and nothing is rewritten.
  expect(bindings.read(session, reader)).toBeUndefined()
  expect(localStorage.length).toBe(1)
  // The page's own resolution then drops it.
  bindings.dropMismatched(session, reader)
  expect(new TaskTabBindings().read(session, page('tab1'))).toBeUndefined()
  expect(localStorage.length).toBe(0)
})

it('keeps a matching entry when the page drops only mismatches', () => {
  const bindings = new TaskTabBindings()
  bindings.write(session, page('tab1'), target('task-1'))
  bindings.dropMismatched(session, page('tab1'))
  expect(bindings.read(session, page('tab1'))).toEqual(target('task-1'))
  // A page with no entry at all is a no-op too.
  bindings.dropMismatched(session, page('tab2'))
  expect(localStorage.length).toBe(1)
})

it('drops entries of tabs the committed layout no longer holds', () => {
  let live: readonly string[] | undefined = ['tab1', 'tab2']
  const bindings = new TaskTabBindings(() => live)
  bindings.write(session, page('tab1'), target('task-1'))
  bindings.write(session, page('tab2'), target('task-2'))
  live = ['tab2']
  bindings.write(session, page('tab2'), target('task-3'))
  const reloaded = new TaskTabBindings()
  expect(reloaded.read(session, page('tab1'))).toBeUndefined()
  expect(reloaded.read(session, page('tab2'))).toEqual(target('task-3'))
})

it('keeps every entry while the committed layout is unknown or empty', () => {
  const layout: { live: readonly string[] | undefined } = { live: undefined }
  const bindings = new TaskTabBindings(() => layout.live)
  bindings.write(session, page('tab1'), target('task-1'))
  layout.live = []
  bindings.write(session, page('tab2'), target('task-2'))
  const reloaded = new TaskTabBindings()
  expect(reloaded.read(session, page('tab1'))).toEqual(target('task-1'))
  expect(reloaded.read(session, page('tab2'))).toEqual(target('task-2'))
})

it('removes one page entry and the Session key with its last entry', () => {
  const bindings = new TaskTabBindings()
  bindings.write(session, page('tab1'), target('task-1'))
  bindings.write(session, page('tab2'), target('task-2'))
  bindings.forget(session, page('tab1'))
  expect(new TaskTabBindings().read(session, page('tab1'))).toBeUndefined()
  expect(new TaskTabBindings().read(session, page('tab2'))).toEqual(target('task-2'))
  bindings.forget(session, page('tab2'))
  expect(localStorage.length).toBe(0)
  expect(bindings.read(session, page('tab2'))).toBeUndefined()
})

it.each(['{broken', 'null', '42', '"text"', '[]'])('ignores an unreadable stored document %s', (raw) => {
  const bindings = new TaskTabBindings()
  bindings.write(session, page('tab1'), target('task-1'))
  localStorage.setItem(storedKey(), raw)
  expect(new TaskTabBindings().read(session, page('tab1'))).toBeUndefined()
})

it('keeps well-formed entries beside malformed ones', () => {
  const bindings = new TaskTabBindings()
  bindings.write(session, page('tab1'), target('task-1'))
  localStorage.setItem(storedKey(), JSON.stringify({
    badKind: { kind: 1, contentId: 'content', sessionId: 'session', id: 'task' },
    badContent: { kind: 'kind', contentId: 2, sessionId: 'session', id: 'task' },
    badSession: { kind: 'kind', contentId: 'content', sessionId: 3, id: 'task' },
    badId: { kind: 'kind', contentId: 'content', sessionId: 'session', id: 4 },
    short: { kind: 'kind', contentId: 'content' },
    scalar: 7,
    list: [],
    empty: null,
    tab1: {
      kind: 'scheduleTask', contentId: 'sidebar://scheduleTask',
      sessionId: session, id: 'task-9',
    },
  }))
  const reloaded = new TaskTabBindings()
  expect(reloaded.read(session, page('tab1'))).toEqual(target('task-9'))
  for (const id of ['badKind', 'badContent', 'badSession', 'badId', 'short', 'scalar', 'list', 'empty']) {
    expect(reloaded.read(session, page(id))).toBeUndefined()
  }
})

it('keeps this window working when storage is absent or rejects writes', () => {
  const bindings = new TaskTabBindings()
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Storage blocked') })
  expect(bindings.read(session, page('tab1'))).toBeUndefined()
  const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage full') })
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('Storage blocked') })
  bindings.write(session, page('tab1'), target('task-1'))
  expect(bindings.read(session, page('tab1'))).toEqual(target('task-1'))
  bindings.forget(session, page('tab1'))
  expect(bindings.read(session, page('tab1'))).toBeUndefined()
  expect(reported).toHaveBeenCalledTimes(2)
  vi.stubGlobal('localStorage', undefined)
  bindings.write(session, page('tab2'), target('task-2'))
  expect(bindings.read(session, page('tab2'))).toEqual(target('task-2'))
  bindings.clear()
  expect(bindings.read(session, page('tab2'))).toBeUndefined()
})
