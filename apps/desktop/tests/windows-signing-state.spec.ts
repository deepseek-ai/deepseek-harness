import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createPackagingRun } from '../scripts/packaging-run.mjs'
import { beginWindowsSigningAttempt } from '../scripts/windows-signing-state.mjs'

describe('persistent Windows signing interlock', () => {
  it('admits one independent process and retains its slot after that process exits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-signing-interlock-'))
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/KEY|SECRET|TOKEN|PASSWORD|^NODE_OPTIONS$/iu.test(name)))
    const stateDirectory = join(root, 'state')
    const acquire = async () => {
      const run = createPackagingRun(root, {})
      const child = spawn(process.execPath, [resolve(import.meta.dirname, 'fixtures/signing-interlock.mjs'), run.directory, stateDirectory], {
        env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      })
      let output = ''
      let error: Error | undefined
      child.stdout.on('data', (data: Buffer) => { output += data.toString() })
      child.once('error', (value) => { error = value })
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
        child.once('close', (code, signal) =>{  done({ code, signal }) })
      })
      expect(error).toBeUndefined()
      expect(result.signal).toBeNull()
      return { ...result, output }
    }
    try {
      const results = await Promise.all([acquire(), acquire()])
      expect(results.map(result => result.code).sort()).toEqual([0, 1])
      expect(results.map(result => result.output).sort()).toEqual(['acquired', 'blocked'])
      expect(await acquire()).toMatchObject({ code: 1, output: 'blocked' })
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('releases only successful attempts and records both operations before completion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-signing-success-'))
    try {
      const run = createPackagingRun(root, {})
      const options = { runDirectory: run.directory, stateDirectory: join(root, 'state'), target: 'fixture.exe' }
      beginWindowsSigningAttempt(options).success()
      beginWindowsSigningAttempt(options).success()
      const events = (await readFile(join(run.directory, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { type: string })
      expect(events.map(event => event.type)).toEqual(['sign-start', 'sign-success', 'sign-start', 'sign-success'])
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('refuses hardware entry without an existing supervised run', () => {
    expect(() => beginWindowsSigningAttempt({ runDirectory: 'relative-missing-run', target: 'fixture.exe' })).toThrow('supervised packaging run')
  })
})
