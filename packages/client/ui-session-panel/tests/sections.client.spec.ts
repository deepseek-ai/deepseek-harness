import { describe, expect, it, vi } from 'vitest'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import { projectSections } from '../src/client/sections.ts'

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
