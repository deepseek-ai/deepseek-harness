import { expect, it } from 'vitest'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { bootstrapArgs } from '../src/launch.ts'

it('uses an explicit installed bootstrap without pretending it maps the host file', () => {
  const fs = { processPathFromHostPath: () => { throw new Error('must not map') } } as unknown as FileSystem
  expect(bootstrapArgs(fs, { bootstrapPath: '/remote/process.js' }, 2048)).toEqual(['/remote/process.js', '2048'])
})

it('fails when the execution world cannot read the source bootstrap', () => {
  const fs = { processPathFromHostPath: () => undefined } as unknown as FileSystem
  expect(() => bootstrapArgs(fs, {}, 2048)).toThrow('unavailable in the subprocess execution world')
})

it('selects the private packaged bootstrap through the existing executable', () => {
  const prior = Object.getOwnPropertyDescriptor(process, 'pkg')
  try {
    Object.defineProperty(process, 'pkg', { configurable: true, value: {} })
    const fs = { processPathFromHostPath: () => { throw new Error('pkg does not expose a host bootstrap file') } } as unknown as FileSystem
    expect(bootstrapArgs(fs, {}, 2048)).toEqual(['2048'])
  } finally {
    if (prior === undefined) Reflect.deleteProperty(process, 'pkg')
    else Object.defineProperty(process, 'pkg', prior)
  }
})
