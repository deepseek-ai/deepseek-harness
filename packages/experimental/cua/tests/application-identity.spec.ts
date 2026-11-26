/** Attribute matching preserves namespaces and closes chains of existing permission records. */
import { expect, it } from 'vitest'
import { applicationAttributes, matchingApplications } from '../src/application-identity.ts'
import type { CuaApplicationId } from '../src/application-types.ts'

const a = 'a'.repeat(64) as CuaApplicationId
const b = 'b'.repeat(64) as CuaApplicationId
const c = 'c'.repeat(64) as CuaApplicationId

it('retains existing single-key identities without matching missing attributes', () => {
  expect(applicationAttributes({ id: a })).toEqual({ 'cua.id': [a] })
  expect(matchingApplications({ [a]: {} }, { id: a })).toEqual([[a, {}]])
  expect(matchingApplications({ [a]: {} }, { id: b })).toEqual([])
})

it('finds a group even when a connecting record appears after a previously unmatched record', () => {
  const applications = {
    [a]: { attributes: { path: ['A'] } },
    [b]: { attributes: { aumid: ['B'], path: ['A'] } },
    [c]: { attributes: { other: ['B'] } },
  }
  expect(matchingApplications(applications, { id: c, attributes: { aumid: ['B'] } }).map(([id]) => id))
    .toEqual([b, c, a])
  expect(applicationAttributes({ id: a, attributes: { path: ['A', 'A'] } }, { id: b, attributes: { path: ['B'] } }))
    .toEqual({ path: ['A', 'B'], 'cua.id': [a, b] })
})
