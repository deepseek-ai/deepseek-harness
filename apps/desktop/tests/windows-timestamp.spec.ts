/** Timestamp retries use fresh signed inputs and cannot publish partial or substituted files. */
import { it, expect, type TestContext } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { completeWindowsSignature, type WindowsTimestampOptions } from '../scripts/windows-timestamp.mjs'

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-timestamp-'))
  t.onTestFinished(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'input.exe')
  const evidenceDirectory = join(root, 'evidence')
  await mkdir(evidenceDirectory)
  await writeFile(path, 'input')
  const state = { hardware: 0, requests: [] as string[], events: [] as object[] }
  const options: WindowsTimestampOptions = {
    evidenceDirectory, thumbprint: 'A'.repeat(40),
    sign: async (file) => { state.hardware++; await writeFile(file, 'signed:input') },
    timestamp: async (file) => { state.requests.push(await readFile(file, 'utf8')); await writeFile(file, 'signed:input:timestamp') },
    normalize: async (file) => { await writeFile(file, (await readFile(file, 'utf8')).replace(':timestamp', '')) },
    inspect: async file => ({ status: 'Valid', timestamped: (await readFile(file, 'utf8')).endsWith(':timestamp'), thumbprint: 'A'.repeat(40) }),
    record: (event) => { state.events.push(event) },
    wait: async () => {},
  }
  return { root, path, options, state }
}

it('a failed timestamp cannot contaminate the next input or repeat hardware signing', async (t) => {
  const f = await fixture(t)
  const timestamp = f.options.timestamp
  let requests = 0
  f.options.timestamp = async (path) => {
    if (++requests === 1) {
      expect(await readFile(path, 'utf8')).toBe('signed:input')
      await writeFile(path, 'damaged by failed timestamp')
      throw Object.assign(new Error('timestamp failed'), { code: 1 })
    }
    await timestamp(path)
  }
  await completeWindowsSignature(f.path, f.options)
  expect(f.state.hardware).toBe(1)
  expect(requests).toBe(2)
  expect(f.state.requests).toEqual(['signed:input'])
  expect(await readFile(f.path, 'utf8')).toBe('signed:input:timestamp')
  expect((await readdir(f.root)).filter(name => name.startsWith('.complete-signature-'))).toEqual([])
})

it('exhausted timestamp attempts retain evidence and leave the original untouched', async (t) => {
  const f = await fixture(t)
  let requests = 0
  f.options.timestamp = async () => { requests++; throw Object.assign(new Error('offline'), { code: 1 }) }
  await expect(completeWindowsSignature(f.path, f.options)).rejects.toThrow('offline')
  expect(requests).toBe(3)
  expect(f.state.hardware).toBe(1)
  expect(await readFile(f.path, 'utf8')).toBe('input')
  expect(await readdir(f.options.evidenceDirectory)).toHaveLength(1)
  expect((await readdir(f.root)).filter(name => name.startsWith('.complete-signature-'))).toEqual([])
})

it('retains staging when failure evidence cannot be stored', async (t) => {
  const f = await fixture(t)
  f.options.evidenceDirectory = f.path
  let staging = ''
  f.options.sign = async (path) => { staging = dirname(path); throw new Error('hardware failed') }
  t.onTestFinished(async () => { if (staging) await rm(staging, { recursive: true, force: true }) })
  await expect(completeWindowsSignature(f.path, f.options)).rejects.toThrow('evidence could not be retained')
  expect(await readdir(staging)).toEqual(['raw.exe'])
  expect(await readFile(f.path, 'utf8')).toBe('input')
})

it('uses short tool paths for deeply nested targets and publishes the completed bytes', async (t) => {
  const f = await fixture(t)
  const directory = join(f.root, 'nested'.repeat(20), 'dependency'.repeat(12))
  await mkdir(directory, { recursive: true })
  const path = join(directory, 'native-module.node')
  await writeFile(path, 'input')
  function checked<T>(operation: (file: string) => Promise<T>) {
    return async (file: string) => {
      expect(file.length).toBeLessThan(260)
      expect(file.endsWith('.node')).toBe(true)
      expect(dirname(file)).not.toBe(directory)
      return operation(file)
    }
  }
  f.options.sign = checked(f.options.sign)
  f.options.timestamp = checked(f.options.timestamp)
  f.options.normalize = checked(f.options.normalize)
  f.options.inspect = checked(f.options.inspect)
  await completeWindowsSignature(path, f.options)
  expect(await readFile(path, 'utf8')).toBe('signed:input:timestamp')
  expect(await readdir(directory)).toEqual(['native-module.node'])
})

for (const failure of [{ code: 'ENOENT' }, { code: 1, killed: true }, { code: 1, signal: 'SIGTERM' }]) {
  it(`does not retry uncertain timestamp process failure ${JSON.stringify(failure)}`, async (t) => {
    const f = await fixture(t)
    let requests = 0
    f.options.timestamp = async () => { requests++; throw Object.assign(new Error('process failure'), failure) }
    await expect(completeWindowsSignature(f.path, f.options)).rejects.toThrow('process failure')
    expect(requests).toBe(1)
    expect(await readFile(f.path, 'utf8')).toBe('input')
  })
}

for (const signature of [
  { status: 'Valid', timestamped: false, thumbprint: 'A'.repeat(40) },
  { status: 'Valid', timestamped: true, thumbprint: 'B'.repeat(40) },
  { status: 'HashMismatch', timestamped: true, thumbprint: 'A'.repeat(40) },
]) it(`rejects successful commands with an invalid final signature ${JSON.stringify(signature)}`, async (t) => {
  const f = await fixture(t)
  f.options.inspect = async () => signature
  await expect(completeWindowsSignature(f.path, f.options)).rejects.toThrow('verification failed')
  expect(f.state.requests).toHaveLength(1)
  expect(await readFile(f.path, 'utf8')).toBe('input')
})

it('rejects changed contents even when the substituted file has the expected valid certificate', async (t) => {
  const f = await fixture(t)
  f.options.timestamp = async (path) => { await writeFile(path, 'signed:different-input:timestamp') }
  await expect(completeWindowsSignature(f.path, f.options)).rejects.toThrow('signing content changed')
  expect(await readFile(f.path, 'utf8')).toBe('input')
})

it('does not overwrite an input changed while its signature is being completed', async (t) => {
  const f = await fixture(t)
  const timestamp = f.options.timestamp
  f.options.timestamp = async (path) => { await timestamp(path); await writeFile(f.path, 'new input') }
  await expect(completeWindowsSignature(f.path, f.options)).rejects.toThrow('input changed before publication')
  expect(await readFile(f.path, 'utf8')).toBe('new input')
})

it('does not retry hardware failures or request timestamps after them', async (t) => {
  const f = await fixture(t)
  f.options.sign = async () => { f.state.hardware++; throw new Error('hardware failed') }
  await expect(completeWindowsSignature(f.path, f.options)).rejects.toThrow('hardware failed')
  expect(f.state.hardware).toBe(1)
  expect(f.state.requests).toHaveLength(0)
  expect(await readFile(f.path, 'utf8')).toBe('input')
})
