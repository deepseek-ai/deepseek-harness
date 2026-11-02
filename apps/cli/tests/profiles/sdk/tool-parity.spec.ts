/** Diagnostics and exact exception consumption for cross-profile tool comparison. */
import { expect, it } from 'vitest'
import { assertToolParity } from './tool-parity.ts'

it('accepts an exact directional exception and rejects it after the profiles converge', () => {
  const exceptions = [{ tool: 'desktop_only', side: 'desktop' as const, reason: 'Requires a graphical client.' }]
  expect(() => { assertToolParity('standard', ['read'], ['read', 'desktop_only'], exceptions) }).not.toThrow()
  expect(() => { assertToolParity('standard', ['read'], ['read'], exceptions) }).toThrow('Stale exceptions: desktop:desktop_only')
  expect(() => { assertToolParity('standard', ['read', 'desktop_only'], ['read'], exceptions) }).toThrow('Only in SDK: desktop_only')
})

it('reports unexpected differences in both directions without hiding shared additions', () => {
  expect(() => { assertToolParity('standard', ['read', 'new_shared'], ['new_shared', 'read'], []) }).not.toThrow()
  expect(() => { assertToolParity('ptc', ['read', 'sdk_extra'], ['read', 'present'], []) }).toThrow(
    'Missing from SDK: present\nOnly in SDK: sdk_extra',
  )
})

it('rejects empty observations, undocumented exceptions and duplicate exceptions', () => {
  expect(() => { assertToolParity('standard', [], [], []) }).toThrow('Empty tool inventory')
  expect(() => { assertToolParity('standard', ['read'], ['read'], [
    { tool: 'extra', side: 'sdk', reason: ' ' },
  ]) }).toThrow('requires a reason')
  const exception = { tool: 'extra', side: 'sdk' as const, reason: 'Intentional.' }
  expect(() => { assertToolParity('standard', ['read', 'extra'], ['read'], [exception, exception]) }).toThrow('Stale exceptions: sdk:extra')
})
