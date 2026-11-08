// @vitest-environment jsdom
/** Viewed marks kept in browser storage per Session and diff source, with their storage bounds. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ViewedFiles, viewedStateOf } from '../src/client/viewed-files.ts'

const FILES = [{ path: 'a.ts', digest: 'a1' }, { path: 'b.ts', digest: 'b1' }]

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('ViewedFiles', () => {
  it('marks a file viewed at its change, reports a later change, and clears the mark', () => {
    const viewed = new ViewedFiles('s1')
    const listener = vi.fn()
    const unsubscribe = viewed.subscribe(listener)
    const before = viewed.marksOf('pr')
    expect(viewed.marksOf('pr')).toBe(before)
    expect(viewedStateOf(before, 'a.ts', 'a1')).toBe('unviewed')

    expect(viewed.mark('pr', FILES, 'a.ts', true)).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)
    const marks = viewed.marksOf('pr')
    expect(marks).not.toBe(before)
    expect(viewed.marksOf('pr')).toBe(marks)
    expect(viewedStateOf(marks, 'a.ts', 'a1')).toBe('viewed')
    expect(viewedStateOf(marks, 'a.ts', 'a2')).toBe('changed')
    expect(viewedStateOf(viewed.marksOf('local'), 'a.ts', 'a1')).toBe('unviewed')

    expect(new ViewedFiles('s1').marksOf('pr').get('a.ts')).toBe('a1')
    expect(new ViewedFiles('s2').marksOf('pr').size).toBe(0)
    expect(viewed.mark('pr', FILES, 'a.ts', false)).toBe(true)
    expect(viewed.marksOf('pr').size).toBe(0)
    unsubscribe()
    viewed.mark('pr', FILES, 'b.ts', true)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('keeps the marks another tab of the Session saved, and shows them as that tab saves them', () => {
    const first = new ViewedFiles('s1')
    const second = new ViewedFiles('s1')
    expect(first.mark('pr', FILES, 'a.ts', true)).toBe(true)
    expect(second.mark('pr', FILES, 'b.ts', true)).toBe(true)
    expect([...new ViewedFiles('s1').marksOf('pr').keys()].sort()).toEqual(['a.ts', 'b.ts'])

    // The first subscriber reads what the other tab saved while nothing listened.
    const listener = vi.fn()
    const unsubscribe = first.subscribe(listener)
    expect([...first.marksOf('pr').keys()].sort()).toEqual(['a.ts', 'b.ts'])
    const stored = (key: string | null): void => { window.dispatchEvent(new StorageEvent('storage', { key })) }
    second.mark('pr', FILES, 'a.ts', false)
    stored('dsh.forge-viewed.v1."s2"')
    expect(listener).not.toHaveBeenCalled()
    stored('dsh.forge-viewed.v1."s1"')
    expect(listener).toHaveBeenCalledTimes(1)
    expect([...first.marksOf('pr').keys()]).toEqual(['b.ts'])
    stored('dsh.forge-viewed.v1."s1"')
    expect(listener).toHaveBeenCalledTimes(1)
    localStorage.clear()
    stored(null)
    expect(first.marksOf('pr').size).toBe(0)
    expect(listener).toHaveBeenCalledTimes(2)

    // The listener on storage stays while another subscriber remains.
    const other = vi.fn()
    const unsubscribeOther = first.subscribe(other)
    unsubscribe()
    second.mark('pr', FILES, 'a.ts', true)
    stored('dsh.forge-viewed.v1."s1"')
    expect(other).toHaveBeenCalledTimes(1)
    localStorage.setItem('dsh.forge-viewed.v1."s1"', '{')
    stored('dsh.forge-viewed.v1."s1"')
    expect(first.marksOf('pr').size).toBe(0)
    unsubscribeOther()
    second.mark('pr', FILES, 'b.ts', true)
    stored('dsh.forge-viewed.v1."s1"')
    expect(other).toHaveBeenCalledTimes(2)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('drops the marks of paths the diff no longer has and refuses a path it does not have', () => {
    const viewed = new ViewedFiles('s1')
    viewed.mark('pr', FILES, 'a.ts', true)
    viewed.mark('pr', [{ path: 'b.ts', digest: 'b1' }], 'b.ts', true)
    expect([...viewed.marksOf('pr').keys()]).toEqual(['b.ts'])
    expect(viewed.mark('pr', FILES, 'gone.ts', true)).toBe(false)
  })

  it('keeps the most recently marked sources of a Session', () => {
    let now = 0
    const viewed = new ViewedFiles('s1', () => ++now)
    for (let index = 0; index < 21; index += 1) viewed.mark(`source-${index}`, FILES, 'a.ts', true)
    expect(viewed.marksOf('source-0').size).toBe(0)
    expect(viewed.marksOf('source-1').size).toBe(1)
    expect(viewed.marksOf('source-20').size).toBe(1)
  })

  it('keeps the marks of the most recently marked Sessions and replaces an unreadable index', () => {
    localStorage.setItem('dsh.forge-viewed.v1.sessions', 'not json')
    for (let index = 0; index < 51; index += 1) new ViewedFiles(`s${index}`).mark('pr', FILES, 'a.ts', true)
    const listed = (): string[] => JSON.parse(localStorage.getItem('dsh.forge-viewed.v1.sessions') ?? '[]') as string[]
    expect(listed()).toHaveLength(50)
    expect(new ViewedFiles('s0').marksOf('pr').size).toBe(0)
    expect(new ViewedFiles('s1').marksOf('pr').size).toBe(1)
    new ViewedFiles('s1').mark('pr', FILES, 'b.ts', true)
    expect(listed()[0]).toBe('s1')
  })

  it('refuses marks when storage is unreadable or refuses the write, keeping the marks it had', () => {
    localStorage.setItem('dsh.forge-viewed.v1."broken"', '{')
    const broken = new ViewedFiles('broken')
    expect(broken.marksOf('pr').size).toBe(0)
    expect(broken.mark('pr', FILES, 'a.ts', true)).toBe(false)
    expect(localStorage.getItem('dsh.forge-viewed.v1."broken"')).toBe('{')

    const viewed = new ViewedFiles('s1')
    viewed.mark('pr', FILES, 'a.ts', true)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    expect(viewed.mark('pr', FILES, 'b.ts', true)).toBe(false)
    expect([...viewed.marksOf('pr').keys()]).toEqual(['a.ts'])
  })

  it('keeps a saved mark when only the Session index cannot be written', () => {
    const write = Storage.prototype.setItem.bind(localStorage)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key: string, value: string) => {
      if (key.endsWith('.sessions')) throw new Error('quota')
      write(key, value)
    })
    const viewed = new ViewedFiles('s1')
    expect(viewed.mark('pr', FILES, 'a.ts', true)).toBe(true)
    expect(new ViewedFiles('s1').marksOf('pr').get('a.ts')).toBe('a1')
  })
})
