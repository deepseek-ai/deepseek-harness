import { expect, it } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { effortDisplayName } from '../src/client/effort-label.ts'
import { de, en, es, fr, ja, pt, ru, zh } from '../src/client/locales.ts'

const standard = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

it.each(Object.entries({ zh, en, ja, es, fr, de, ru, pt }))('localizes canonical effort names in %s without changing IDs', (_locale, dictionary) => {
  const t = makeTranslate(dictionary)
  for (const id of standard) {
    for (const name of [id, id.toUpperCase(), id[0]!.toUpperCase() + id.slice(1)]) {
      const effort = { id, name }
      expect(effortDisplayName(effort, t)).toBe(dictionary[`effort.${id}`])
      expect(effort.id).toBe(id)
      expect(effort.name).toBe(name)
    }
  }
})

it.each([
  { id: 'high', name: 'High budget for code review' },
  { id: 'high', name: ' high' },
  { id: 'high', name: 'High ' },
  { id: 'xhigh', name: 'Extra high' },
  { id: 'standard', name: 'Standard' },
  { id: 'retired', name: 'High' },
  { id: 'High', name: 'High' },
])('preserves provider spelling for $id / $name', (effort) => {
  expect(effortDisplayName(effort, makeTranslate(zh))).toBe(effort.name)
})
