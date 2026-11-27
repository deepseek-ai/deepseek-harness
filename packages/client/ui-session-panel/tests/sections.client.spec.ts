import { describe, expect, it, vi } from 'vitest'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots/client'
import { orderSections, projectSections } from '../src/client/sections.ts'

function entry(id: string, order: number | undefined, label: StoredEntry['options']['label'], registrant?: string): StoredEntry {
  return {
    component: () => null,
    options: { id, ...order === undefined ? {} : { order }, ...label === undefined ? {} : { label } },
    ...registrant === undefined ? {} : { registrant },
  }
}

describe('projectSections', () => {
  it('orders sections by ascending order, keeping registration order for ties, and resolves locale thunks', () => {
    const report = vi.fn()
    const sections = projectSections([
      entry('later', 100, 'Change requests'),
      entry('first', 0, () => 'Environment'),
      entry('tie', 100, 'Outputs'),
      entry('default', undefined, 'Default order'),
    ], report)
    expect(sections).toEqual([
      { id: 'first', label: 'Environment' },
      { id: 'default', label: 'Default order' },
      { id: 'later', label: 'Change requests' },
      { id: 'tie', label: 'Outputs' },
    ])
    expect(report).not.toHaveBeenCalled()
  })

  it('reports and leaves out a section that cannot be titled', () => {
    const report = vi.fn()
    const sections = projectSections([
      entry('untitled', 0, undefined, 'acme-plugin'),
      entry('blank', 1, ''),
      entry('titled', 2, 'Titled'),
    ], report)
    expect(sections).toEqual([{ id: 'titled', label: 'Titled' }])
    expect(report).toHaveBeenCalledTimes(2)
    expect(report.mock.calls[0]?.[0]).toContain('"untitled" from acme-plugin')
    expect(report.mock.calls[1]?.[0]).toContain('"blank" from an unknown registrant')
  })
})

describe('orderSections', () => {
  const section = (id: string) => ({ id, label: id.toUpperCase() })
  const registered = [section('environment'), section('changes'), section('subagents'), section('jobs')]
  const ids = (preferred: readonly string[], sections = registered): string[] => orderSections(sections, preferred).map(entry => entry.id)

  it('keeps the registered order, and the same array, while the reader chose none of the live sections', () => {
    expect(orderSections(registered, [])).toBe(registered)
    expect(orderSections(registered, ['gone', 'also-gone'])).toBe(registered)
  })

  it('puts the sections the choice names in its order, ignoring unknown and repeated ids', () => {
    expect(ids(['environment', 'jobs', 'subagents', 'changes'])).toEqual(['environment', 'jobs', 'subagents', 'changes'])
    expect(ids(['jobs', 'gone', 'jobs', 'subagents', 'changes'])).toEqual(['environment', 'jobs', 'subagents', 'changes'])
  })

  it('places a section the choice does not name after the one it follows in the registered order', () => {
    // `changes` has no section before it once Environment is set aside, so it leads; `jobs` follows `subagents`.
    expect(ids(['subagents', 'environment'])).toEqual(['environment', 'changes', 'subagents', 'jobs'])
    expect(ids(['jobs', 'changes'])).toEqual(['environment', 'jobs', 'changes', 'subagents'])
  })

  it('keeps Environment first whatever place the choice or the registered order gives it', () => {
    expect(ids(['jobs', 'subagents', 'environment', 'changes'])).toEqual(['environment', 'jobs', 'subagents', 'changes'])
    // A section registered ahead of Environment still shows after it, with or without a choice.
    const early = [section('early'), ...registered]
    expect(ids([], early)).toEqual(['environment', 'early', 'changes', 'subagents', 'jobs'])
    expect(ids(['jobs', 'early'], early)).toEqual(['environment', 'jobs', 'early', 'changes', 'subagents'])
    // Without an Environment section nothing is held first.
    const without = registered.slice(1)
    expect(orderSections(without, [])).toBe(without)
    expect(ids(['jobs'], without)).toEqual(['changes', 'subagents', 'jobs'])
  })
})
