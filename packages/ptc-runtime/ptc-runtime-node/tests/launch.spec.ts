import { expect, it } from 'vitest'
import { bootstrapArgs, resolveLaunch } from '../src/launch.ts'

const unmapped = { processPathFromHostPath: () => undefined }
const noMapping = { processPathFromHostPath: () => { throw new Error('must not map a remote worker') } }

it('uses an explicit installed bootstrap without pretending it maps the host file', () => {
  expect(bootstrapArgs(noMapping, { kind: 'node-script', executable: '/remote/node', bootstrapPath: '/remote/process.js' }, 2048))
    .toEqual(['/remote/process.js', '2048'])
})

it('fails when the execution world cannot read the source bootstrap', () => {
  expect(() => bootstrapArgs(unmapped, { kind: 'node-script', executable: process.execPath }, 2048))
    .toThrow('unavailable in the subprocess execution world')
})

it('uses a remote embedded worker when the client runs ordinary Node', () => {
  const launch = resolveLaunch({ kind: 'embedded', executable: '/remote/dsh-ssh-helper' })
  expect(launch).toEqual({ kind: 'embedded', executable: '/remote/dsh-ssh-helper' })
  expect(bootstrapArgs(noMapping, launch, 2048)).toEqual(['2048'])
})

it('resolves the local carrier once while preserving an explicit remote script choice', () => {
  const prior = Object.getOwnPropertyDescriptor(process, 'pkg')
  try {
    Object.defineProperty(process, 'pkg', { configurable: true, value: {} })
    expect(resolveLaunch()).toEqual({ kind: 'embedded', executable: process.execPath })
    const remote = resolveLaunch({ kind: 'node-script', executable: '/remote/node', bootstrapPath: '/remote/process.js' })
    expect(bootstrapArgs(noMapping, remote, 2048)).toEqual(['/remote/process.js', '2048'])
  } finally {
    if (prior === undefined) Reflect.deleteProperty(process, 'pkg')
    else Object.defineProperty(process, 'pkg', prior)
  }
  expect(resolveLaunch()).toEqual({ kind: 'node-script', executable: process.execPath })
})
